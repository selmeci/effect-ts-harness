import { execFileSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { constants as moduleConstants } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
      specifiers: [
        { type: "ImportSpecifier", imported: { name: "runSync" }, local: { name: "runSync" } },
      ],
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
    mcpRule.MemberExpression(makeRunMember("runPromiseExit"))
    expect(mcpReports.filter((m) => m.includes("unscoped-effect-run"))).toHaveLength(3)

    const mcpBoundaryReports: Array<string> = []
    const mcpBoundaryRule = syntaxBansPlugin.rules["syntax-bans"].create({
      filename: "apps/harness-mcp/src/server.ts",
      sourceCode: { text: "export const x = 1" },
      report: (r: { readonly message: string }) => {
        mcpBoundaryReports.push(r.message)
      },
    })
    mcpBoundaryRule.Program({ type: "Program", body: [] })
    mcpBoundaryRule.MemberExpression(makeRunMember("runPromise"))
    mcpBoundaryRule.MemberExpression(makeRunMember("runPromiseExit"))
    expect(mcpBoundaryReports.filter((m) => m.includes("unscoped-effect-run"))).toHaveLength(1)
  })

  it("S-6.1: node-ts-resolver fast-paths .js -> .ts, preserves real .js, resolves dynamic exports, honors NODE_COMPILE_CACHE, and logs genuine fallbacks", async () => {
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
    const parentURL = pathToFileURL(fileURLToPath(new URL("../src/index.ts", import.meta.url))).href
    const stderrChunks: Array<string> = []
    const origWrite = process.stderr.write.bind(process.stderr)
    const prevDebug = process.env["HARNESS_DEBUG_RESOLVER"]
    process.env["HARNESS_DEBUG_RESOLVER"] = "1"
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
      return true
    }) as typeof process.stderr.write

    try {
      // 1. Fast-path relative .js -> .ts calls nextResolve ONCE directly with .ts (no ERR_MODULE_NOT_FOUND throw)
      const directCalls: Array<string> = []
      const resolved = await resolverMod.resolve(
        "./policy.js?v=1#top",
        { parentURL, conditions: ["node", "import"] },
        async (specifier: string) => {
          directCalls.push(specifier)
          return { url: specifier, shortCircuit: true }
        },
      )
      expect(directCalls).toHaveLength(1)
      expect(resolved.url).toContain("policy.ts?v=1#top")
      expect(stderrChunks.join("")).toBe("")

      // 2. Real .js files win over .ts (tools/oxlint/syntax-bans.js exists on disk)
      const toolsParentUrl = pathToFileURL(
        fileURLToPath(new URL("../../../../tools/node-ts-resolver.mjs", import.meta.url)),
      ).href
      const realJsCalls: Array<string> = []
      await resolverMod.resolve(
        "./oxlint/syntax-bans.js",
        { parentURL: toolsParentUrl, conditions: ["node", "import"] },
        async (specifier: string) => {
          realJsCalls.push(specifier)
          return { url: specifier, shortCircuit: true }
        },
      )
      expect(realJsCalls).toEqual(["./oxlint/syntax-bans.js"])

      // 3. Dynamic package.json "exports" subpath resolution
      const exportCalls: Array<string> = []
      const exportResolved = await resolverMod.resolve(
        "@harness/service/host-io",
        { parentURL, conditions: ["node", "import"] },
        async (specifier: string) => {
          exportCalls.push(specifier)
          return { url: specifier, shortCircuit: true }
        },
      )
      expect(exportCalls).toHaveLength(1)
      expect(exportResolved.url).toContain("libs/harness/service/src/host-io.ts")

      // 4. Genuine fallback debug logging when nextResolve rejects
      await expect(
        resolverMod.resolve(
          "@nonexistent/missing-pkg",
          { parentURL, conditions: ["node", "import"] },
          async (specifier: string) => {
            const err = new Error(`Cannot find module ${specifier}`) as Error & { code?: string }
            err.code = "ERR_MODULE_NOT_FOUND"
            throw err
          },
        ),
      ).rejects.toThrow()
      expect(stderrChunks.join("")).toContain(
        "[node-ts-resolver] primary fallback for '@nonexistent/missing-pkg'",
      )

      // 5. NODE_COMPILE_CACHE env override is supported in resolver source
      const resolverSource = await import("node:fs/promises").then((fs) =>
        fs.readFile(fileURLToPath(resolverUrl), "utf8"),
      )
      expect(resolverSource).toContain("process.env.NODE_COMPILE_CACHE")
    } finally {
      process.stderr.write = origWrite
      if (prevDebug === undefined) {
        delete process.env["HARNESS_DEBUG_RESOLVER"]
      } else {
        process.env["HARNESS_DEBUG_RESOLVER"] = prevDebug
      }
    }
  })

  it("S-5.2b: initCompileCache warns on FAILED or throw, and stays silent on ENABLED, ALREADY_ENABLED, and DISABLED", async () => {
    const resolverMod = (await import(resolverUrl)) as {
      readonly initCompileCache: (
        enableFn?: (dir: string) => {
          readonly status: number
          readonly directory?: string
          readonly message?: string
        },
        cacheDir?: string,
        statusConstants?: {
          readonly FAILED: number
          readonly ENABLED: number
          readonly ALREADY_ENABLED: number
          readonly DISABLED: number
        },
        stderr?: { readonly write: (chunk: string) => boolean },
      ) => unknown
    }
    const statusConstants = moduleConstants.compileCacheStatus
    const makeStderr = () => {
      const chunks: Array<string> = []
      return {
        chunks,
        stream: {
          write: (chunk: string) => {
            chunks.push(chunk)
            return true
          },
        },
      }
    }

    // FAILED -> emits warning with message
    const failedStderr = makeStderr()
    resolverMod.initCompileCache(
      () => ({ status: statusConstants.FAILED, message: "read-only fs" }),
      "/tmp/readonly-cache",
      statusConstants,
      failedStderr.stream,
    )
    expect(failedStderr.chunks.join("")).toContain("failed to enable V8 compile cache")
    expect(failedStderr.chunks.join("")).toContain("read-only fs")

    // Throwing enableCompileCache -> emits warning
    const throwStderr = makeStderr()
    resolverMod.initCompileCache(
      () => {
        throw new Error("permission denied")
      },
      "/tmp/denied-cache",
      statusConstants,
      throwStderr.stream,
    )
    expect(throwStderr.chunks.join("")).toContain("enableCompileCache threw")
    expect(throwStderr.chunks.join("")).toContain("permission denied")

    // ENABLED, ALREADY_ENABLED, DISABLED -> silent
    for (const status of [
      statusConstants.ENABLED,
      statusConstants.ALREADY_ENABLED,
      statusConstants.DISABLED,
    ]) {
      const okStderr = makeStderr()
      resolverMod.initCompileCache(
        () => ({ status, directory: "/tmp/ok-cache" }),
        "/tmp/ok-cache",
        statusConstants,
        okStderr.stream,
      )
      expect(okStderr.chunks).toHaveLength(0)
    }

    // UID-scoped default dir + symlink rejection + 0777 permission tightening
    const fullResolverMod = (await import(resolverUrl)) as {
      readonly resolveDefaultCompileCacheDir: (uid?: number) => string
      readonly initCompileCache: (
        enableFn?: (dir: string) => {
          readonly status: number
          readonly directory?: string
          readonly message?: string
        },
        cacheDir?: string,
        statusConstants?: {
          readonly FAILED: number
          readonly ENABLED: number
          readonly ALREADY_ENABLED: number
          readonly DISABLED: number
        },
        stderr?: { readonly write: (chunk: string) => boolean },
      ) => { readonly status: number; readonly message?: string } | null
    }
    expect(fullResolverMod.resolveDefaultCompileCacheDir(1000)).toContain(
      "effect-harness-v8-compile-cache-1000",
    )

    const tmpBase = mkdtempSync(join(tmpdir(), "compile-cache-sec-"))
    try {
      const targetDir = join(tmpBase, "real-target")
      mkdirSync(targetDir, { recursive: true })
      const symCacheDir = join(tmpBase, "sym-cache")
      symlinkSync(targetDir, symCacheDir)

      let enableCalls = 0
      const symStderr = makeStderr()
      const symRes = fullResolverMod.initCompileCache(
        () => {
          enableCalls += 1
          return { status: statusConstants.ENABLED }
        },
        symCacheDir,
        statusConstants,
        symStderr.stream,
      )
      expect(enableCalls).toBe(0)
      expect(symRes?.status).toBe(statusConstants.FAILED)
      expect(symStderr.chunks.join("")).toContain("symlink or non-directory")

      const danglingLink = join(tmpBase, "dangling-cache")
      symlinkSync(join(tmpBase, "missing-target"), danglingLink)
      const danglingRes = fullResolverMod.initCompileCache(
        () => {
          enableCalls += 1
          return { status: statusConstants.ENABLED }
        },
        danglingLink,
        statusConstants,
        makeStderr().stream,
      )
      expect(enableCalls).toBe(0)
      expect(danglingRes?.status).toBe(statusConstants.FAILED)

      const fileCachePath = join(tmpBase, "file-cache")
      writeFileSync(fileCachePath, "not-a-dir", "utf8")
      const fileRes = fullResolverMod.initCompileCache(
        () => {
          enableCalls += 1
          return { status: statusConstants.ENABLED }
        },
        fileCachePath,
        statusConstants,
        makeStderr().stream,
      )
      expect(enableCalls).toBe(0)
      expect(fileRes?.status).toBe(statusConstants.FAILED)

      const looseDir = join(tmpBase, "loose-cache")
      mkdirSync(looseDir, { recursive: true })
      chmodSync(looseDir, 0o777)
      const looseStderr = makeStderr()
      const looseRes = fullResolverMod.initCompileCache(
        () => {
          enableCalls += 1
          return { status: statusConstants.ENABLED, directory: looseDir }
        },
        looseDir,
        statusConstants,
        looseStderr.stream,
      )
      expect(enableCalls).toBe(1)
      expect(looseRes?.status).toBe(statusConstants.ENABLED)
      expect(statSync(looseDir).mode & 0o077).toBe(0)
      expect(looseStderr.chunks).toHaveLength(0)
    } finally {
      rmSync(tmpBase, { recursive: true, force: true })
    }
  })

  it("S-1.6: hook-fastpath and cluster-resolver subpaths never load typescript or @harness/graph barrel", () => {
    const repoRoot = dirname(dirname(fileURLToPath(resolverUrl)))
    const resolverRelPath = "./tools/node-ts-resolver.mjs"
    const loaderSrc = `
      export async function resolve(specifier, context, nextResolve) {
        const res = await nextResolve(specifier, context);
        if (
          specifier === "typescript" ||
          res.url.includes("/node_modules/typescript/") ||
          res.url.endsWith("/libs/harness/graph/src/index.ts")
        ) {
          throw new Error(
            "FORBIDDEN_IMPORT: " + specifier + " -> " + res.url + " (from " + (context.parentURL ?? "") + ")"
          );
        }
        return res;
      }
    `
    const script = `
      import { register } from "node:module";
      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loaderSrc)}));
      await import("@harness/gates/hook-fastpath");
      await import("@harness/decision/hook-fastpath");
      await import("@harness/infra/hook-fastpath");
      await import("@harness/graph/cluster-resolver");
      process.stdout.write("CLOSURE_OK");
    `
    const out = execFileSync(
      process.execPath,
      ["--import", join(repoRoot, resolverRelPath), "--input-type=module", "-e", script],
      { cwd: repoRoot, encoding: "utf8" },
    )
    expect(out).toContain("CLOSURE_OK")
  })

  it("SPEC-0022: @harness/gates/policy and @harness/infra/hook-io resolve cleanly without loading effect barrel or typescript", () => {
    const repoRoot = dirname(dirname(fileURLToPath(resolverUrl)))
    const resolverRelPath = "./tools/node-ts-resolver.mjs"
    const loaderSrc = `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "effect" || specifier === "typescript") {
          throw new Error(
            "FORBIDDEN_IMPORT: " + specifier + " (from " + (context.parentURL ?? "") + ")"
          );
        }
        const res = await nextResolve(specifier, context);
        if (
          res.url.includes("/node_modules/typescript/") ||
          res.url.endsWith("/effect/dist/index.js")
        ) {
          throw new Error(
            "FORBIDDEN_RESOLVED_IMPORT: " + specifier + " -> " + res.url + " (from " + (context.parentURL ?? "") + ")"
          );
        }
        return res;
      }
    `
    const script = `
      import { register } from "node:module";
      register("data:text/javascript," + encodeURIComponent(${JSON.stringify(loaderSrc)}));
      const policy = await import("@harness/gates/policy");
      const hookIo = await import("@harness/infra/hook-io");
      if (typeof policy.classifyCommand !== "function" || typeof hookIo.findWorkspaceRootLite !== "function") {
        throw new Error("MISSING_EXPORTS");
      }
      process.stdout.write("LIGHTWEIGHT_CLOSURE_OK");
    `
    const out = execFileSync(
      process.execPath,
      ["--import", join(repoRoot, resolverRelPath), "--input-type=module", "-e", script],
      { cwd: repoRoot, encoding: "utf8" },
    )
    expect(out).toContain("LIGHTWEIGHT_CLOSURE_OK")
  })
})
