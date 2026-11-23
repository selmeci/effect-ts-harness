import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

const astGrepParseSpy = vi.hoisted(() => ({
  calls: [] as Array<string>,
}))

vi.mock("@ast-grep/napi", () =>
  vi.importActual<typeof import("@ast-grep/napi")>("@ast-grep/napi").then((actual) => ({
    ...actual,
    parse: (lang: Parameters<typeof actual.parse>[0], src: string) => {
      astGrepParseSpy.calls.push(src)
      return actual.parse(lang, src)
    },
  })),
)
import {
  buildWorkspaceFnIndex,
  findActiveWorkspaceStubs,
  indexEffectFnsInFile,
  validateUniqueSpanNames,
} from "../src/fn-index.js"
import { testHostIo } from "./helpers/test-host-io.js"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../../../..")
const syntaxBansPluginMod = await import(
  pathToFileURL(path.resolve(repoRoot, "tools/oxlint/syntax-bans.js")).href
)
const syntaxBansPlugin = syntaxBansPluginMod.default

describe("Effect.fn syntactic index", () => {
  it("extracts exported Effect.fn declarations and detects stub() bodies", () => {
    const src = `
      import { Effect } from "effect"
      import { stub } from "@harness/contract"
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
        isStub: false,
      },
      {
        qualname: "libs/sample/domain/src/index.ts#pending",
        spanName: "Sample.pending",
        exportName: "pending",
        file: "libs/sample/domain/src/index.ts",
        line: 7,
        packageTag: "domain",
        isStub: true,
      },
    ])
  })

  it("reports duplicate spanName across indexed functions", () => {
    const a = indexEffectFnsInFile(
      "a.ts",
      `export const f = Effect.fn("Dup")(function* () {})`,
      "domain",
    )
    const b = indexEffectFnsInFile(
      "b.ts",
      `export const g = Effect.fn("Dup")(function* () {})`,
      "domain",
    )
    const result = validateUniqueSpanNames([...a, ...b])
    expect(result.duplicates).toEqual(["Dup"])
  })

  it.effect(
    "buildWorkspaceFnIndex indexes workspace and finds Album.decide and Sample.logToConsole",
    () =>
      Effect.gen(function* () {
        const index = yield* buildWorkspaceFnIndex(repoRoot, testHostIo)
        expect(index.bySpanName.has("Album.decide")).toBe(true)
        const decide = index.bySpanName.get("Album.decide")
        expect(decide).toBeDefined()
        expect(decide?.packageTag).toBe("domain")
        expect(decide?.exportName).toBe("decideAlbumQuota")
        expect(decide?.file).toBe("libs/sample/domain/src/index.ts")
        expect(decide?.qualname).toBe("libs/sample/domain/src/index.ts#decideAlbumQuota")
        expect(decide?.isStub).toBe(false)

        expect(index.bySpanName.has("Sample.logToConsole")).toBe(true)
        const logFn = index.bySpanName.get("Sample.logToConsole")
        expect(logFn).toBeDefined()
        expect(logFn?.packageTag).toBe("infra")
        expect(logFn?.exportName).toBe("logToConsole")
        expect(logFn?.file).toBe("libs/sample/infra/src/index.ts")
        expect(logFn?.qualname).toBe("libs/sample/infra/src/index.ts#logToConsole")
        expect(logFn?.isStub).toBe(false)

        expect(index.duplicates).toEqual([])
      }),
  )

  it("oxlint rule rejects non-literal Effect.fn arguments and accepts literal spans", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]

    // 1. Rejects dynamic name argument
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" },
        },
        arguments: [{ type: "Identifier", name: "dynamicName" }],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name')).",
      )
    }

    // 2. Rejects empty string literal
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" },
        },
        arguments: [{ type: "Literal", value: "   " }],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name')).",
      )
    }

    // 3. Rejects missing argument
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" },
        },
        arguments: [],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Effect.fn must be called with a non-empty string literal span name (e.g. Effect.fn('Module.name')).",
      )
    }

    // 4. Accepts valid literal
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "fn" },
        },
        arguments: [{ type: "Literal", value: "Valid.span" }],
      })
      expect(reports).toHaveLength(0)
    }
  })

  it("oxlint rule rejects uninstrumented domain exports and accepts Effect.fn wrappers", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]

    // 5. Rejects uninstrumented arrow function in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "unwrapped" },
              init: { type: "ArrowFunctionExpression" },
            },
          ],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation.",
      )
    }

    // 6. Rejects function declaration in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "FunctionDeclaration",
          id: { type: "Identifier", name: "badFn" },
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation.",
      )
    }

    // 7. Rejects Effect.fnUntraced in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
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
                  property: { type: "Identifier", name: "fnUntraced" },
                },
                arguments: [],
              },
            },
          ],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation.",
      )
    }

    // 8. Allows Effect.fn("Sample.f")(function* () {}) in domain src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
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
                    property: { type: "Identifier", name: "fn" },
                  },
                  arguments: [{ type: "Literal", value: "Sample.f" }],
                },
                arguments: [{ type: "FunctionExpression" }],
              },
            },
          ],
        },
      })
      expect(reports).toHaveLength(0)
    }
  })

  it("oxlint rule applies Effect.fn export enforcement to sample infra and excludes contract", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]

    // 9. Rejects uninstrumented arrow function in sample infra src
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/infra/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "logToConsole" },
              init: { type: "ArrowFunctionExpression" },
            },
          ],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toBe(
        "Exported domain functions must use Effect.fn('LiteralName') for runtime trace correlation.",
      )
    }

    // 10. Does not report non-sample/domain/service/infra files (e.g. contract)
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/contract/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ExportNamedDeclaration({
        type: "ExportNamedDeclaration",
        declaration: {
          type: "VariableDeclaration",
          declarations: [
            {
              type: "VariableDeclarator",
              id: { type: "Identifier", name: "helper" },
              init: { type: "ArrowFunctionExpression" },
            },
          ],
        },
      })
      expect(reports).toHaveLength(0)
    }
  })

  it("oxlint rule rejects @effect-diagnostics directives and SwitchStatement in test-integrity", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]

    // 11. Rejects @effect-diagnostics and @effect-diagnostics-next-line directives in syntax-bans and test-integrity
    {
      const directivePrefix = "@effect-" + "diagnostics"
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        sourceCode: {
          text: `// ${directivePrefix} floatingEffect:off\nexport const x = 1\n`,
        },
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program({ type: "Program" })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain(directivePrefix)

      const testRule = syntaxBansPlugin.rules["test-integrity"]
      const testReports: Array<{ message: string }> = []
      const testVisitor = testRule.create({
        filename: "/repo/libs/sample/domain/test/index.test.ts",
        sourceCode: {
          text: `// ${directivePrefix}-next-line lazyEffect:off\n`,
        },
        report: (r: { message: string }) => {
          testReports.push(r)
        },
      })
      testVisitor.Program({ type: "Program" })
      expect(testReports).toHaveLength(1)
      expect(testReports[0]?.message).toContain(directivePrefix)

      // test-integrity also bans SwitchStatement in tests
      const switchReports: Array<{ message: string }> = []
      const switchVisitor = testRule.create({
        filename: "/repo/libs/sample/domain/test/index.test.ts",
        report: (r: { message: string }) => {
          switchReports.push(r)
        },
      })
      switchVisitor.SwitchStatement({ type: "SwitchStatement" })
      expect(switchReports).toHaveLength(1)
      expect(switchReports[0]?.message).toContain("No switch statements")
    }
  })

  it("oxlint rule bans switch, else-if chains, and discriminant if/ternary expressions", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]

    // 12a. Enforces ts-pattern exhaustive matching and bans switch, else-if, and discriminant if/ternary
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
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
          right: { type: "Literal", value: 10 },
        },
        consequent: { type: "BlockStatement", body: [] },
        alternate: {
          type: "IfStatement",
          test: {
            type: "BinaryExpression",
            operator: ">",
            left: { type: "Identifier", name: "count" },
            right: { type: "Literal", value: 5 },
          },
          consequent: { type: "BlockStatement", body: [] },
          alternate: null,
        },
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
            property: { type: "Identifier", name: "_tag" },
          },
          right: { type: "Literal", value: "Active" },
        },
        consequent: { type: "BlockStatement", body: [] },
        alternate: { type: "BlockStatement", body: [] },
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
            property: { type: "Identifier", name: "isSome" },
          },
          arguments: [{ type: "Identifier", name: "opt" }],
        },
        consequent: { type: "Literal", value: 1 },
        alternate: { type: "Literal", value: 0 },
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
            property: { type: "Identifier", name: "length" },
          },
          right: { type: "Literal", value: 0 },
        },
        consequent: { type: "BlockStatement", body: [] },
        alternate: { type: "BlockStatement", body: [] },
      })
      expect(reports).toHaveLength(4)
    }
  })

  it("oxlint rule bans match().run() and union .otherwise() while allowing primitive .otherwise()", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })

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
                arguments: [{ type: "Identifier", name: "x" }],
              },
              property: { type: "Identifier", name: "with" },
            },
            arguments: [{ type: "Literal", value: 1 }, { type: "ArrowFunctionExpression" }],
          },
          property: { type: "Identifier", name: "run" },
        },
        arguments: [],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("match(...).run() is banned")

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
                arguments: [{ type: "Identifier", name: "x" }],
              },
              property: { type: "Identifier", name: "with" },
            },
            arguments: [
              {
                type: "ObjectExpression",
                properties: [
                  {
                    type: "Property",
                    key: { type: "Identifier", name: "_tag" },
                    value: { type: "Literal", value: "A" },
                  },
                ],
              },
              { type: "ArrowFunctionExpression" },
            ],
          },
          property: { type: "Identifier", name: "otherwise" },
        },
        arguments: [{ type: "ArrowFunctionExpression" }],
      })
      expect(reports).toHaveLength(2)
      expect(reports[1]?.message).toContain(
        "Do not use .otherwise() when matching on discriminated union tags",
      )

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
                arguments: [{ type: "Identifier", name: "num" }],
              },
              property: { type: "Identifier", name: "with" },
            },
            arguments: [{ type: "Literal", value: 1 }, { type: "ArrowFunctionExpression" }],
          },
          property: { type: "Identifier", name: "otherwise" },
        },
        arguments: [{ type: "ArrowFunctionExpression" }],
      })
      expect(reports).toHaveLength(2)
    }
  })

  it("oxlint rule rejects unscoped-effect-run namespace, computed-element, and destructuring bypasses", () => {
    const rule = syntaxBansPlugin.rules["syntax-bans"]
    // 7. Rejects unscoped-effect-run namespace, computed-element, and destructuring bypasses
    {
      const reports: Array<{ message: string }> = []
      const visitor = rule.create({
        filename: "/repo/libs/sample/domain/src/index.ts",
        sourceCode: {
          text: "",
          getText: (n: { name?: string; value?: string }) => n.name ?? n.value ?? "expr",
        },
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.Program({ type: "Program", body: [] })
      visitor.ImportDeclaration({
        type: "ImportDeclaration",
        importKind: "value",
        source: { type: "Literal", value: "effect" },
        specifiers: [
          { type: "ImportNamespaceSpecifier", local: { type: "Identifier", name: "Fx" } },
        ],
      })

      // Fx.Effect.runSync(...)
      visitor.MemberExpression({
        type: "MemberExpression",
        computed: false,
        object: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Fx" },
          property: { type: "Identifier", name: "Effect" },
        },
        property: { type: "Identifier", name: "runSync" },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("unscoped-effect-run")

      // Effect["runSync"](...)
      visitor.MemberExpression({
        type: "MemberExpression",
        computed: true,
        object: { type: "Identifier", name: "Effect" },
        property: { type: "Literal", value: "runSync" },
      })
      expect(reports).toHaveLength(2)
      expect(reports[1]?.message).toContain("unscoped-effect-run")

      // const { runSync } = Effect; runSync(...)
      visitor.VariableDeclarator({
        type: "VariableDeclarator",
        id: {
          type: "ObjectPattern",
          properties: [
            {
              type: "Property",
              computed: false,
              key: { type: "Identifier", name: "runSync" },
              value: { type: "Identifier", name: "runSync" },
            },
          ],
        },
        init: { type: "Identifier", name: "Effect" },
      })
      visitor.CallExpression({
        type: "CallExpression",
        callee: { type: "Identifier", name: "runSync" },
        arguments: [],
      })
      expect(reports).toHaveLength(3)
      expect(reports[2]?.message).toContain("unscoped-effect-run")
    }
  })

  it.effect(
    "findActiveWorkspaceStubs matches buildWorkspaceFnIndex active-stub extraction across stub, comment-only, Effect.fn-without-stub, and non-Effect files",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => mkdtempSync(path.join(tmpdir(), "fn-index-stubs-"))),
        (tempRoot) =>
          Effect.gen(function* () {
            const write = (relPath: string, content: string) => {
              const abs = path.join(tempRoot, relPath)
              mkdirSync(path.dirname(abs), { recursive: true })
              writeFileSync(abs, content, "utf8")
            }

            // 1. Active stub via stub<A, E, R>() and Contract.stub() alongside non-stub Effect.fn
            write(
              "libs/alpha/domain/package.json",
              JSON.stringify({ name: "@test/alpha-domain", nx: { tags: ["type:domain"] } }),
            )
            write(
              "libs/alpha/domain/src/stubbed.ts",
              `
                // FN_INDEX_PARITY_TEST_MARKER
                import { Effect } from "effect"
                import * as Contract from "@harness/contract"
                import { stub } from "@harness/contract"
                export const pendingOne = Effect.fn("Alpha.pendingOne")(function* (id: string) {
                  return yield* stub<string, never, never>(id)
                })
                export const pendingTwo = Effect.fn("Alpha.pendingTwo")(function* () {
                  return yield* Contract.stub<number, never, never>()
                })
                export const implemented = Effect.fn("Alpha.implemented")(function* () {
                  return "ok"
                })
              `,
            )

            // 2. Effect.fn with comments/strings mentioning "stub" but no stub() call
            write(
              "libs/beta/domain/package.json",
              JSON.stringify({ name: "@test/beta-domain", nx: { tags: ["type:domain"] } }),
            )
            write(
              "libs/beta/domain/src/comment-only.ts",
              `
                // FN_INDEX_PARITY_TEST_MARKER
                import { Effect } from "effect"
                // This used to be a stub, now implemented
                export const ready = Effect.fn("Beta.ready")(function* () {
                  const note = "not a stub anymore"
                  return note
                })
              `,
            )

            // 3. Effect.fn without any mention of "stub"
            write(
              "libs/gamma/infra/package.json",
              JSON.stringify({ name: "@test/gamma-infra", nx: { tags: ["type:infra"] } }),
            )
            write(
              "libs/gamma/infra/src/no-stub.ts",
              `
                // FN_INDEX_PARITY_TEST_MARKER
                import { Effect } from "effect"
                export const run = Effect.fn("Gamma.run")(function* () {
                  return 42
                })
              `,
            )

            // 4. Non-Effect file mentioning "stub" in comment/identifier
            write(
              "libs/delta/contract/package.json",
              JSON.stringify({ name: "@test/delta-contract", nx: { tags: ["type:contract"] } }),
            )
            write(
              "libs/delta/contract/src/non-effect.ts",
              `
                // FN_INDEX_PARITY_TEST_MARKER
                // stub helper type only, plain constant export
                export const stubLabel = "stub"
              `,
            )

            // 5. App file with active stub
            write(
              "apps/sample-app/src/main.ts",
              `
                // FN_INDEX_PARITY_TEST_MARKER
                import { Effect } from "effect"
                import { stub } from "@harness/contract"
                export const boot = Effect.fn("App.boot")(function* () {
                  return yield* stub<void, never, never>()
                })
              `,
            )

            astGrepParseSpy.calls = []
            const activeStubs = yield* findActiveWorkspaceStubs(tempRoot, testHostIo)
            // REQ-2.2: AST parse is called ONLY for files containing both "Effect.fn" and "stub"
            // (stubbed.ts, comment-only.ts, and main.ts = 3 calls; no-stub.ts and non-effect.ts = 0 calls)
            const parsedInTemp = astGrepParseSpy.calls.filter((s) =>
              s.includes("FN_INDEX_PARITY_TEST_MARKER"),
            )
            expect(parsedInTemp).toHaveLength(3)
            expect(parsedInTemp.every((s) => s.includes("Effect.fn") && s.includes("stub"))).toBe(
              true,
            )
            expect(parsedInTemp.some((s) => s.includes("Gamma.run"))).toBe(false)
            expect(parsedInTemp.some((s) => s.includes("stubLabel"))).toBe(false)

            const fullIndex = yield* buildWorkspaceFnIndex(tempRoot, testHostIo)
            const expectedFromIndex = Array.from(fullIndex.bySpanName.values())
              .filter((fn) => fn.isStub)
              .map((fn) => fn.spanName)

            expect(activeStubs).toEqual(["Alpha.pendingOne", "Alpha.pendingTwo", "App.boot"])
            expect(activeStubs).toEqual(expectedFromIndex)

            // Verify indexEffectFnsInFile early-return on non-Effect files
            expect(
              indexEffectFnsInFile(
                "libs/delta/contract/src/non-effect.ts",
                `export const stubLabel = "stub"`,
                "contract",
              ),
            ).toEqual([])
          }),
        (tempRoot) =>
          Effect.sync(() => {
            rmSync(tempRoot, { recursive: true, force: true })
          }),
      ),
  )

  it.effect(
    "findActiveWorkspaceStubs matches buildWorkspaceFnIndex active stubs on the live workspace",
    () =>
      Effect.gen(function* () {
        const activeStubs = yield* findActiveWorkspaceStubs(repoRoot, testHostIo)
        const fullIndex = yield* buildWorkspaceFnIndex(repoRoot, testHostIo)
        const expectedFromIndex = Array.from(fullIndex.bySpanName.values())
          .filter((fn) => fn.isStub)
          .map((fn) => fn.spanName)

        expect(activeStubs).toEqual(expectedFromIndex)
      }),
  )
})
