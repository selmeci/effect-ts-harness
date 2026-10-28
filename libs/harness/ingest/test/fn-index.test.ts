import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  buildWorkspaceFnIndex,
  indexEffectFnsInFile,
  validateUniqueSpanNames
} from "../src/fn-index.js"
// @ts-expect-error - JS plugin without ambient typings
// oxlint-disable-next-line @nx/enforce-module-boundaries
import syntaxBansPlugin from "../../../../tools/oxlint/syntax-bans.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../../../..")

describe("Effect.fn syntactic index", () => {
  it("extracts exported Effect.fn declarations and detects stub() bodies", () => {
    const src = `
      import { Effect } from "effect"
      import { stub } from "@harness/gates"
      export const greet = Effect.fn("Sample.greet")(function* (input: { name: string }) {
        return \`Hello, \${input.name}!\`
      })
      export const pending = Effect.fn("Sample.pending")(function* (id: string) {
        return yield* stub<string>(id)
      })
    `
    const fns = indexEffectFnsInFile("libs/sample/domain/src/index.ts", src, "domain")
    expect(fns).toEqual([
      {
        qualname: "libs/sample/domain/src/index.ts#greet",
        spanName: "Sample.greet",
        exportName: "greet",
        file: "libs/sample/domain/src/index.ts",
        line: 4,
        packageTag: "domain",
        isStub: false
      },
      {
        qualname: "libs/sample/domain/src/index.ts#pending",
        spanName: "Sample.pending",
        exportName: "pending",
        file: "libs/sample/domain/src/index.ts",
        line: 7,
        packageTag: "domain",
        isStub: true
      }
    ])
  })

  it("reports duplicate spanName across indexed functions", () => {
    const a = indexEffectFnsInFile("a.ts", `export const f = Effect.fn("Dup")(function* () {})`, "domain")
    const b = indexEffectFnsInFile("b.ts", `export const g = Effect.fn("Dup")(function* () {})`, "domain")
    const result = validateUniqueSpanNames([...a, ...b])
    expect(result.duplicates).toEqual(["Dup"])
  })

  it.effect("buildWorkspaceFnIndex indexes workspace and finds Sample.greet and Sample.logToConsole", () =>
    Effect.gen(function* () {
      const index = yield* buildWorkspaceFnIndex(repoRoot)
      expect(index.bySpanName.has("Sample.greet")).toBe(true)
      const greet = index.bySpanName.get("Sample.greet")
      expect(greet).toBeDefined()
      expect(greet?.packageTag).toBe("domain")
      expect(greet?.exportName).toBe("greet")
      expect(greet?.file).toBe("libs/sample/domain/src/index.ts")
      expect(greet?.qualname).toBe("libs/sample/domain/src/index.ts#greet")
      expect(greet?.isStub).toBe(false)

      expect(index.bySpanName.has("Sample.logToConsole")).toBe(true)
      const logFn = index.bySpanName.get("Sample.logToConsole")
      expect(logFn).toBeDefined()
      expect(logFn?.packageTag).toBe("infra")
      expect(logFn?.exportName).toBe("logToConsole")
      expect(logFn?.file).toBe("libs/sample/infra/src/index.ts")
      expect(logFn?.qualname).toBe("libs/sample/infra/src/index.ts#logToConsole")
      expect(logFn?.isStub).toBe(false)

      expect(index.duplicates).toEqual([])
    })
  )

  it("oxlint rule rejects non-literal Effect.fn arguments and uninstrumented domain/infra exports", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]

    // 1. Rejects dynamic name argument
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" }
        },
        arguments: [{ type: "Identifier", name: "dynamicName" }]
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name'))."
      )
    }

    // 2. Rejects empty string literal
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" }
        },
        arguments: [{ type: "Literal", value: "   " }]
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name'))."
      )
    }

    // 3. Rejects missing argument
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" }
        },
        arguments: []
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name'))."
      )
    }

    // 4. Accepts valid literal
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" }
        },
        arguments: [{ type: "Literal", value: "Valid.span" }]
      })
      expect(reports).toHaveLength(0)
    }

    // 5. Rejects uninstrumented arrow function in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "unwrapped" },
              init: { type: "ArrowFunctionExpression" }
            }
          ]
        }
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation."
      )
    }

    // 6. Rejects function declaration in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "FunctionDeclaration",
          id: { type: "Identifier", name: "badFn" }
        }
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation."
      )
    }

    // 7. Rejects Effect.fnUntraced in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "f" },
              init: {
                type: "CallExpression",
                callee: {
                  type: "MemberExpression",
                  computed: false,
                  object: { type: "Identifier", name: "Effect" },
                  property: { type: "Identifier", name: "fnUntraced" }
                },
                arguments: []
              }
            }
          ]
        }
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation."
      )
    }

    // 8. Allows Effect.fn("Sample.f")(function* () {}) in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "f" },
              init: {
                type: "CallExpression",
                callee: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Effect" },
                    property: { type: "Identifier", name: "fn" }
                  },
                  arguments: [{ type: "Literal", value: "Sample.f" }]
                },
                arguments: [{ type: "FunctionExpression" }]
              }
            }
          ]
        }
      })
      expect(reports).toHaveLength(0)
    }

    // 9. Rejects uninstrumented arrow function in sample infra src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/infra/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "logToConsole" },
              init: { type: "ArrowFunctionExpression" }
            }
          ]
        }
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation."
      )
    }

    // 10. Does not report non-sample/domain/service/infra files (e.g. contract)
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "helper" },
              init: { type: "ArrowFunctionExpression" }
            }
          ]
        }
      })
      expect(reports).toHaveLength(0)
    }

    // 11. Rejects @effect-diagnostics and @effect-diagnostics-next-line directives in syntax-bans and test-integrity
    {
      const directivePrefix = "@effect-" + "diagnostics"
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        sourceCode: {
          text: `// ${directivePrefix} floatingEffect:off\nexport const x = 1\n`
        },
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })
      visitor.Program({ type: "Program" })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(directivePrefix)

      const testRule = syntaxBansPlugin.rules["test-integrity"]
      const testReports: Array<{ message: string }> = []
      const testVisitor = testRule.create({
        filename: "/repo/libs/sample/domain/test/index.test.ts",
        sourceCode: {
          text: `// ${directivePrefix}-next-line lazyEffect:off\n`
        },
        report: (r: { message: string }) => {
          testReports.push(r)
        }
      })
      testVisitor.Program({ type: "Program" })
      expect(testReports).toHaveLength(1)
      expect(testReports[0]?.message).toContain(directivePrefix)
    }

    // 12. Enforces ts-pattern exhaustive matching and bans switch, else-if, discriminant if/ternary, match().run(), and union .otherwise()
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        }
      })

      // SwitchStatement is banned
      visitor.SwitchStatement({ type: "SwitchStatement" })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("No switch statements")

      // else-if chain is banned
      visitor.IfStatement({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: ">",
          left: { type: "Identifier", name: "count" },
          right: { type: "Literal", value: 10 }
        },
        consequent: { type: "BlockStatement", body: [] },
        alternate: {
          type: "IfStatement",
          test: {
            type: "BinaryExpression",
            operator: ">",
            left: { type: "Identifier", name: "count" },
            right: { type: "Literal", value: 5 }
          },
          consequent: { type: "BlockStatement", body: [] },
          alternate: null
        }
      })
      expect(reports).toHaveLength(2)
      expect(reports[1]?.message).toContain("No if/else-if chains")

      // if checking discriminant property (_tag) is banned even for 2 states
      visitor.IfStatement({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "state" },
            property: { type: "Identifier", name: "_tag" }
          },
          right: { type: "Literal", value: "Active" }
        },
        consequent: { type: "BlockStatement", body: [] },
        alternate: { type: "BlockStatement", body: [] }
      })
      expect(reports).toHaveLength(3)
      expect(reports[2]?.message).toContain("enumerate all states with match")

      // ternary checking Option.isSome is banned
      visitor.ConditionalExpression({
        type: "ConditionalExpression",
        test: {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Option" },
            property: { type: "Identifier", name: "isSome" }
          },
          arguments: [{ type: "Identifier", name: "opt" }]
        },
        consequent: { type: "Literal", value: 1 },
        alternate: { type: "Literal", value: 0 }
      })
      expect(reports).toHaveLength(4)
      expect(reports[3]?.message).toContain("enumerate all states with match")

      // Simple non-discriminant if-else is allowed
      visitor.IfStatement({
        type: "IfStatement",
        test: {
          type: "BinaryExpression",
          operator: "===",
          left: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "items" },
            property: { type: "Identifier", name: "length" }
          },
          right: { type: "Literal", value: 0 }
        },
        consequent: { type: "BlockStatement", body: [] },
        alternate: { type: "BlockStatement", body: [] }
      })
      expect(reports).toHaveLength(4)

      // match(...).with(...).run() is banned
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              computed: false,
              object: {
                type: "CallExpression",
                callee: { type: "Identifier", name: "match" },
                arguments: [{ type: "Identifier", name: "x" }]
              },
              property: { type: "Identifier", name: "with" }
            },
            arguments: [{ type: "Literal", value: 1 }, { type: "ArrowFunctionExpression" }]
          },
          property: { type: "Identifier", name: "run" }
        },
        arguments: []
      })
      expect(reports).toHaveLength(5)
      expect(reports[4]?.message).toContain("match(...).run() is banned")

      // match(...).with({ _tag: "A" }, ...).otherwise(...) is banned
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              computed: false,
              object: {
                type: "CallExpression",
                callee: { type: "Identifier", name: "match" },
                arguments: [{ type: "Identifier", name: "x" }]
              },
              property: { type: "Identifier", name: "with" }
            },
            arguments: [
              {
                type: "ObjectExpression",
                properties: [
                  {
                    type: "Property",
                    key: { type: "Identifier", name: "_tag" },
                    value: { type: "Literal", value: "A" }
                  }
                ]
              },
              { type: "ArrowFunctionExpression" }
            ]
          },
          property: { type: "Identifier", name: "otherwise" }
        },
        arguments: [{ type: "ArrowFunctionExpression" }]
      })
      expect(reports).toHaveLength(6)
      expect(reports[5]?.message).toContain("Do not use .otherwise() when matching on discriminated union tags")

      // match(num).with(1, ...).otherwise(...) on primitive is allowed
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: {
            type: "CallExpression",
            callee: {
              type: "MemberExpression",
              computed: false,
              object: {
                type: "CallExpression",
                callee: { type: "Identifier", name: "match" },
                arguments: [{ type: "Identifier", name: "num" }]
              },
              property: { type: "Identifier", name: "with" }
            },
            arguments: [{ type: "Literal", value: 1 }, { type: "ArrowFunctionExpression" }]
          },
          property: { type: "Identifier", name: "otherwise" }
        },
        arguments: [{ type: "ArrowFunctionExpression" }]
      })
      expect(reports).toHaveLength(6)
    }
  })
})
