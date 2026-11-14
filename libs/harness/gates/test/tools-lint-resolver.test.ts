import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, it } from "@effect/vitest"

const syntaxBansUrl = new URL("../../../../tools/oxlint/syntax-bans.js", import.meta.url).href
const resolverUrl = new URL("../../../../tools/node-ts-resolver.mjs", import.meta.url).href

describe("tools/oxlint/syntax-bans.js & tools/node-ts-resolver.mjs (S-4.1, S-6.1, S-6.2)", () => {
  it("S-4.1: exports isEnforcedWorkspaceFile and enforces rules on libs/harness/* and apps/harness-*", async () => {
    const mod = (await import(syntaxBansUrl)) as {
      readonly isEnforcedWorkspaceFile: (filename: string) => boolean
    }
    expect(mod.isEnforcedWorkspaceFile("libs/harness/gates/src/policy.ts")).toBe(true)
    expect(mod.isEnforcedWorkspaceFile("apps/harness-cli/src/index.ts")).toBe(true)
    expect(mod.isEnforcedWorkspaceFile("libs/sample/domain/src/cart.ts")).toBe(true)
    expect(mod.isEnforcedWorkspaceFile("scripts/standalone.ts")).toBe(false)
  })

  it("S-6.2: getSourceCode falls back to getSourceCode(), never returns fullText when range is missing, and reports missing-source-code", async () => {
    const mod = (await import(syntaxBansUrl)) as {
      readonly default: {
        readonly rules: {
          readonly "syntax-bans": {
            readonly create: (ctx: unknown) => {
              readonly Program: (node: unknown) => void
              readonly ImportDeclaration: (node: unknown) => void
              readonly MemberExpression: (node: unknown) => void
              readonly CallExpression: (node: unknown) => void
            }
          }
        }
      }
    }
    const syntaxBansPlugin = mod.default
    const missingReports: Array<string> = []
    const missingRule = syntaxBansPlugin.rules["syntax-bans"].create({
      filename: "libs/harness/gates/src/dummy.ts",
      sourceCode: null,
      report: (r: { readonly message: string }) => {
        missingReports.push(r.message)
      },
    })
    missingRule.Program({ type: "Program", body: [] })
    expect(missingReports.some((m) => m.includes("missing-source-code"))).toBe(true)

    const fallbackReports: Array<string> = []
    const fullFileText = "export const ok = 1;\nexport const bad = Effect.ignore(x);\n"
    const fallbackRule = syntaxBansPlugin.rules["syntax-bans"].create({
      filename: "libs/sample/domain/src/dummy.ts",
      getSourceCode: () => ({
        text: fullFileText,
        getText: (n: { readonly _nodeText?: string }) => n._nodeText ?? "",
      }),
      report: (r: { readonly message: string }) => {
        fallbackReports.push(r.message)
      },
    })
    fallbackRule.Program({ type: "Program", body: [] })
    expect(fallbackReports.some((m) => m.includes("missing-source-code"))).toBe(false)

    // Node without range and empty getText should NOT receive fullFileText (which contains Effect.ignore)
    fallbackRule.CallExpression({
      type: "CallExpression",
      callee: { type: "Identifier", name: "safeFn" },
      arguments: [],
    })
    expect(fallbackReports).toHaveLength(0)

    // Omitted sourceCode/getSourceCode AND empty getText on non-empty Program MUST report missing-source-code
    const omittedReports: Array<string> = []
    const omittedRule = syntaxBansPlugin.rules["syntax-bans"].create({
      filename: "libs/harness/gates/src/dummy.ts",
      report: (r: { readonly message: string }) => {
        omittedReports.push(r.message)
      },
    })
    omittedRule.Program({ type: "Program", body: [] })
    expect(omittedReports.some((m) => m.includes("missing-source-code"))).toBe(true)

    // Empty sc.text on non-empty Program MUST also report missing-source-code
    const emptyScTextReports: Array<string> = []
    const emptyScTextRule = syntaxBansPlugin.rules["syntax-bans"].create({
      filename: "libs/harness/gates/src/dummy.ts",
      sourceCode: { text: "" },
      report: (r: { readonly message: string }) => {
        emptyScTextReports.push(r.message)
      },
    })
    emptyScTextRule.Program({ type: "Program", body: [{ type: "EmptyStatement" }] })
    expect(emptyScTextReports.some((m) => m.includes("missing-source-code"))).toBe(true)

    // S-3.2: Effect.runSync/runSyncExit/runPromise/runPromiseExit enforcement via MemberExpression & effect/Effect import
    const makeRunMember = (methodName: string) => ({
      type: "MemberExpression",
      computed: false,
      object: { type: "Identifier", name: "Effect" },
      property: { type: "Identifier", name: methodName },
    })
    const cliReports: Array<string> = []
    const cliRule = syntaxBansPlugin.rules["syntax-bans"].create({
      filename: "apps/harness-cli/src/commands/x.ts",
      sourceCode: { text: "export const x = 1" },
      report: (r: { readonly message: string }) => {
        cliReports.push(r.message)
      },
    })
    cliRule.Program({ type: "Program", body: [] })
    cliRule.MemberExpression(makeRunMember("runSync"))
    cliRule.MemberExpression(makeRunMember("runPromise"))
    cliRule.ImportDeclaration({
      type: "ImportDeclaration",
      source: { value: "effect/Effect" },
      specifiers: [{ type: "ImportSpecifier", imported: { name: "runSync" }, local: { name: "runSync" } }],
    })
    expect(cliReports.filter((m) => m.includes("unscoped-effect-run"))).toHaveLength(3)

    const mcpReports: Array<string> = []
    const mcpRule = syntaxBansPlugin.rules["syntax-bans"].create({
      filename: "apps/harness-mcp/src/tools/x.ts",
      sourceCode: { text: "export const x = 1" },
      report: (r: { readonly message: string }) => {
        mcpReports.push(r.message)
      },
    })
    mcpRule.Program({ type: "Program", body: [] })
    mcpRule.MemberExpression(makeRunMember("runSync"))
    mcpRule.MemberExpression(makeRunMember("runPromise"))
    expect(mcpReports.filter((m) => m.includes("unscoped-effect-run"))).toHaveLength(1)
  })

  it("S-6.1: node-ts-resolver resolves .js -> .ts workspace imports and logs diagnostics when HARNESS_DEBUG_RESOLVER=1", async () => {
    const resolverMod = (await import(resolverUrl)) as {
      readonly resolve: (
        specifier: string,
        context: { readonly parentURL: string; readonly conditions: ReadonlyArray<string> },
        nextResolve: (
          specifier: string,
          context: unknown,
        ) => Promise<{ readonly url: string; readonly shortCircuit?: boolean }>,
      ) => Promise<{ readonly url: string }>
    }
    const parentURL = pathToFileURL(
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ).href
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    const prevDebug = process.env["HARNESS_DEBUG_RESOLVER"]
    process.env["HARNESS_DEBUG_RESOLVER"] = "1"
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write

    try {
      const resolved = await resolverMod.resolve(
        "./policy.js",
        { parentURL, conditions: ["node", "import"] },
        async (specifier: string) => {
          if (specifier.endsWith(".js")) {
            const err = new Error(`Cannot find module ${specifier}`) as Error & { code?: string }
            err.code = "ERR_MODULE_NOT_FOUND"
            throw err
          }
          return { url: specifier, shortCircuit: true }
        },
      )
      expect(resolved.url).toContain("policy.ts")
      expect(stderrChunks.join("")).toContain("[node-ts-resolver] primary fallback for './policy.js'")
    } finally {
      process.stderr.write = origWrite
      if (prevDebug === undefined) {
        delete process.env["HARNESS_DEBUG_RESOLVER"]
      } else {
        process.env["HARNESS_DEBUG_RESOLVER"] = prevDebug
      }
    }
  })
})
