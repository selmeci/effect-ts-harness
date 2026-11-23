import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  MaxPluginFileLines,
} from "@harness/contract"
import { buildHarnessGraph, ts } from "@harness/graph"
import {
  decideSelfDogfooding,
  isGraphOrchestratorFacadePath,
  isModularPluginPath,
  resolvePathSpecificMaxLines,
  SelfDogfooding,
} from "../src/plugins/self-dogfooding-plugin.js"
import { testHostIo } from "./helpers/test-host-io.js"
import {
  decideMutationCheck,
  discoverDomainMutants,
  evaluateMutantSchemaInProcess,
} from "../src/mutation-check.js"
import { MUTATION_PATTERNS } from "../src/mutation/mutant-ast-generator.js"
import {
  AstGateCache,
  type AstGateCacheEntry,
  MAX_GATE_CACHE_SIZE,
  visitSourceFileSinglePass,
} from "../src/ast-cache.js"
import {
  collectModularPluginFiles,
  decideGraphEntropy,
  extractBalancedBraces,
  extractBalancedParens,
  extractTopLevelObjectAnalysis,
  findClosestMatch,
  GcFinding,
  GcFindingKind,
  levenshteinDistance,
} from "../src/gc-check.js"

describe("Self-Dogfooding Capability Plugins & AST Gate Rules (SPEC-0011)", () => {
  it.effect(
    "AstGateCache.decide table-driven rules: impure-domain-import, domain-effect-ignore, ast-grep-tsx-grammar, unscoped-effect-run, fallback-json-equality, and cache eviction",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          readonly name: string
          readonly filePath: string
          readonly packageTag?: "app" | "contract" | "domain" | "infra" | "service" | "test"
          readonly content: string
          readonly expectedRule: string
        }> = [
          {
            name: "impure-domain-import in type:domain",
            filePath: "libs/sample/domain/src/impure.ts",
            packageTag: "domain",
            content: 'import {readFileSync} from "node:fs"\nexport const x = readFileSync("a")\n',
            expectedRule: "impure-domain-import",
          },
          {
            name: "domain-effect-ignore in type:domain",
            filePath: "libs/sample/domain/src/ignore.ts",
            packageTag: "domain",
            content: "export const f = () => Effect.ignore(Effect.succeed(1))\n",
            expectedRule: "domain-effect-ignore",
          },
          {
            name: "ast-grep-tsx-grammar for .tsx with parse(Lang.TypeScript, ...)",
            filePath: "libs/harness/gates/src/sample-tsx-check.ts",
            content:
              'export const p = (filePath: string, src: string) => filePath.endsWith(".tsx") ? parse(Lang.TypeScript, src) : null\n',
            expectedRule: "ast-grep-tsx-grammar",
          },
          {
            name: "unscoped-effect-run inside Effect.fn",
            filePath: "libs/sample/infra/src/nested-run.ts",
            packageTag: "infra",
            content:
              'export const bad = Effect.fn("bad")(function* () { return Effect.runSync(Effect.succeed(1)) })\n',
            expectedRule: "unscoped-effect-run",
          },
          {
            name: "fallback-json-equality via JSON.stringify comparison in test file",
            filePath: "libs/sample/domain/test/json-eq.test.ts",
            packageTag: "test",
            content:
              "export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)\n",
            expectedRule: "fallback-json-equality",
          },
        ]

        for (const tc of cases) {
          const report = yield* AstGateCache.decide({
            files: [
              {
                filePath: AstSourceFilePath.make(tc.filePath),
                content: AstSourceContent.make(tc.content),
                ...(tc.packageTag !== undefined
                  ? { packageTag: AstGatePackageTag.make(tc.packageTag) }
                  : {}),
              },
            ],
          })
          expect(
            report.violations.map((v) => v.rule),
            `Expected ${tc.expectedRule} for case '${tc.name}'`,
          ).toContain(tc.expectedRule)
        }

        // Verify local cacheStore & MAX_GATE_CACHE_SIZE export
        const cacheStore = new Map<string, AstGateCacheEntry>()
        expect(cacheStore.size).toBe(0)
        expect(MAX_GATE_CACHE_SIZE).toBe(1000)
        yield* AstGateCache.decide(
          {
            files: [
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/clean.ts"),
                content: AstSourceContent.make("export const cleanVal = 42\n"),
              },
            ],
          },
          cacheStore,
        )
        expect(cacheStore.size).toBe(1)
        cacheStore.clear()
        expect(cacheStore.size).toBe(0)
      }),
  )

  it.effect(
    "decideGraphEntropy: covers node-sqlite-in-infra filter, unparseable governance doc frontmatter, architecture-policy-violation, orphan-effect-fn schema, and gc-helpers parsers",
    () =>
      Effect.gen(function* () {
        // 1. Branching violations: only node-sqlite-in-infra is emitted by evaluateBranchingSqliteViolations
        const baseGraph = buildHarnessGraph({})
        const report = yield* decideGraphEntropy({
          graph: {
            ...baseGraph,
            branchingViolations: [
              {
                rule: "node-sqlite-in-infra",
                file: "libs/sample/infra/src/sqlite-bad.ts",
                line: 3,
                enclosingSymbol: "badImport",
                message: "Importing node:sqlite is banned in type:infra.",
              },
              {
                rule: "discriminant-branching",
                file: "libs/sample/domain/src/switch-bad.ts",
                line: 10,
                enclosingSymbol: "badSwitch",
                message: "Switch statement is banned.",
              },
            ],
          },
          governanceDocs: [
            {
              id: "harness:SPEC-BROKEN",
              docPath: "libs/harness/docs/specs/broken.md",
              status: "accepted",
              enforcedByFiles: [],
              referencedSpans: [],
              referencedServices: [],
              referencedErrors: [],
              markdown: "# Broken doc without YAML frontmatter\n",
            },
          ],
        })

        expect(report.clean).toBe(false)
        const kinds = report.findings.map((f) => f.kind)
        expect(kinds).toContain("node-sqlite-in-infra")
        expect(kinds).toContain("stale-doc-reference")
        expect(kinds).not.toContain("architecture-policy-violation")

        // 2. orphan-effect-fn is a valid GcFindingKind and decodes through GcFinding
        expect(Schema.is(GcFindingKind)("orphan-effect-fn")).toBe(true)
        expect(
          Schema.is(GcFinding)({
            kind: "orphan-effect-fn",
            nodeId: "fn:Sample.orphan",
            message: "Orphan Effect.fn span",
            action: "Wire or remove orphan span",
          }),
        ).toBe(true)

        // 3. Direct tests for gc-helpers parsers
        expect(levenshteinDistance("kitten", "sitting")).toBe(3)
        expect(findClosestMatch("UserServic", ["UserService", "OrderService"])).toBe("UserService")
        expect(extractBalancedBraces("const x = { a: { b: 1 } };", 10)).toEqual({
          body: " a: { b: 1 } ",
          endIndex: 24,
        })
        expect(extractBalancedParens("fn(a, (b + c))", 2)).toEqual({
          body: "a, (b + c)",
          endIndex: 13,
        })
        expect(extractTopLevelObjectAnalysis("a: 1, b: { nested: 2 }, ...rest")).toEqual({
          keys: ["a", "b"],
          spreads: ["rest"],
        })

        // 4. architecture-policy-violation emitted when workspaceRoot has modular plugin or circular-import violations
        const tmpWs = mkdtempSync(join(tmpdir(), "harness-gc-arch-"))
        const gatesSrc = join(tmpWs, "libs", "harness", "gates", "src")
        mkdirSync(gatesSrc, { recursive: true })
        writeFileSync(
          join(gatesSrc, "a.ts"),
          'import {b} from "./b.js"\nexport const a = Effect.fn("a")(function* () { yield* Effect.void; return b })\n',
        )
        writeFileSync(
          join(gatesSrc, "b.ts"),
          'import {a} from "./a.js"\nexport const b = 1\nexport const ref = a\n',
        )
        const wsReport = yield* decideGraphEntropy({
          graph: baseGraph,
          workspaceRoot: tmpWs,
          hostIo: testHostIo,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(tmpWs, { recursive: true, force: true })
            }),
          ),
        )
        expect(wsReport.clean).toBe(false)
        const archFindings = wsReport.findings.filter(
          (f) => f.kind === "architecture-policy-violation",
        )
        expect(archFindings.some((f) => f.nodeId.includes("effect-fn-dummy-void"))).toBe(true)
        expect(archFindings.some((f) => f.nodeId.includes("circular-import"))).toBe(true)
      }),
  )

  it.effect(
    "evaluateMutantSchemaInProcess: kills mutant on AssertionError or false, and does not kill on non-assertion runtime defect",
    () =>
      Effect.sync(() => {
        const mutants = discoverDomainMutants(
          "libs/sample/domain/src/calc.ts",
          "export const isPositive = (n: number): boolean => n >= 0\n",
        )
        expect(mutants.length).toBeGreaterThan(0)
        expect(MUTATION_PATTERNS.length).toBeGreaterThanOrEqual(8)
        expect(typeof decideMutationCheck).toBe("function")

        // 1. Assertion failure (expect(1).toBe(2)) kills the mutant cleanly
        const killedByAssertion = evaluateMutantSchemaInProcess(mutants, [
          () => {
            expect(1).toBe(2)
          },
        ])
        expect(killedByAssertion.every((o) => o.status === "killed")).toBe(true)

        // 2. Returning false kills the mutant cleanly
        const killedByFalse = evaluateMutantSchemaInProcess(mutants, [() => false])
        expect(killedByFalse.every((o) => o.status === "killed")).toBe(true)

        // 3. Non-assertion runtime defect (SyntaxError from JSON.parse) does not count as killed
        const nonAssertionOutcomes = evaluateMutantSchemaInProcess(mutants, [
          () => {
            JSON.parse("{broken-json")
          },
        ])
        expect(nonAssertionOutcomes.every((o) => o.status === "survived")).toBe(true)
      }),
  )

  it.effect(
    "RFC-0007 Step 4: resolvePathSpecificMaxLines & isModularPluginPath enforce repo-wide tiered LOC budgets across libs/ and apps/",
    () =>
      Effect.sync(() => {
        expect(isGraphOrchestratorFacadePath("libs/harness/graph/src/type-extractor.ts")).toBe(true)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/type-extractor.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/datalog-engine.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/graph-rewrite.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/graph-engine.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/graph-projector.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/index.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/server.ts")).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/index.ts", 800)).toBe(250)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/server.ts", 800)).toBe(250)

        expect(
          resolvePathSpecificMaxLines("libs/harness/graph/src/extractor/effect-fn-extractor.ts"),
        ).toBe(499)

        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/commands/verify.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/tools/graph.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("apps/harness-mcp/src/daemon/worker.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("libs/es/infra/src/projector.ts")).toBe(650)
        expect(resolvePathSpecificMaxLines("libs/es/infra/src/memory.ts", 800)).toBe(650)

        expect(
          resolvePathSpecificMaxLines("libs/harness/graph/src/extractor/compiler-session.ts"),
        ).toBe(700)
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/engine/snapshot-codec.ts")).toBe(
          700,
        )
        expect(
          resolvePathSpecificMaxLines("libs/harness/graph/src/datalog/datalog-session.ts"),
        ).toBe(750)

        expect(resolvePathSpecificMaxLines("libs/harness/gates/src/plugins/sample.ts")).toBe(800)
        expect(resolvePathSpecificMaxLines("libs/sample/domain/src/index.ts")).toBe(800)
        expect(resolvePathSpecificMaxLines("apps/sample/alchemy.run.ts")).toBe(800)
        expect(resolvePathSpecificMaxLines("apps/sample-web/src/client.ts")).toBe(800)

        // Stricter explicit maxPluginFileLines still tightens tiered budgets
        expect(resolvePathSpecificMaxLines("libs/harness/graph/src/type-extractor.ts", 100)).toBe(
          100,
        )
        expect(resolvePathSpecificMaxLines("apps/harness-cli/src/index.ts", 100)).toBe(100)

        // isModularPluginPath matches all production .ts/.tsx files under libs/ and apps/ and excludes test/d.ts/config/build dirs
        expect(isModularPluginPath("libs/sample/domain/src/index.ts")).toBe(true)
        expect(isModularPluginPath("libs/es/infra/src/projector.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-cli/src/index.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-cli/src/commands/verify.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-mcp/src/server.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-mcp/src/tools/graph.ts")).toBe(true)
        expect(isModularPluginPath("apps/harness-mcp/src/daemon/worker.ts")).toBe(true)
        expect(isModularPluginPath("apps/sample/alchemy.run.ts")).toBe(true)
        expect(isModularPluginPath("apps/sample-web/src/client.tsx")).toBe(true)

        expect(isModularPluginPath("libs/sample/domain/test/index.test.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/decision/src/cached-decision-model.spec.ts")).toBe(
          false,
        )
        expect(isModularPluginPath("libs/sample/infra/src/global.d.ts")).toBe(false)
        expect(isModularPluginPath("libs/sample/infra/drizzle.config.ts")).toBe(false)
        expect(isModularPluginPath("apps/harness-cli/vitest.config.ts")).toBe(false)
        expect(isModularPluginPath("libs/es/core/test/fixtures/cart.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/gates/dist/index.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/gates/node_modules/pkg/index.ts")).toBe(false)
        expect(isModularPluginPath("libs/harness/gates/repos/effect/index.ts")).toBe(false)
        expect(isModularPluginPath("tools/oxlint/syntax-bans.js")).toBe(false)
      }),
  )

  it.effect(
    "Unit 1: facade-star-reexport flags export * from orchestrator facades while allowing named exports and index.ts export *",
    () =>
      Effect.gen(function* () {
        // 1. Violating: export * from in orchestrator facade
        const violatingReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/type-extractor.ts"),
              content: AstSourceContent.make('export * from "./extractor/compiler-session.js"\n'),
            },
          ],
        })
        expect(violatingReport.verdict).toBe("violated")
        expect(violatingReport.violations.some((v) => v.rule === "facade-star-reexport")).toBe(true)

        // 2. Violating: export * from in package src/index.ts barrel (S-1.1)
        const violatingIndexReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/index.ts"),
              content: AstSourceContent.make('export * from "./model.js"\n'),
            },
          ],
        })
        expect(
          violatingIndexReport.violations.filter((v) => v.rule === "facade-star-reexport"),
        ).toHaveLength(1)

        // 3. Allowed: explicit named export in orchestrator facade and src/index.ts
        const allowedNamedReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/type-extractor.ts"),
              content: AstSourceContent.make(
                'export { createCompilerSession } from "./extractor/compiler-session.js"\n',
              ),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/index.ts"),
              content: AstSourceContent.make('export { classifyCommand } from "./policy.js"\n'),
            },
          ],
        })
        expect(
          allowedNamedReport.violations.filter((v) => v.rule === "facade-star-reexport"),
        ).toHaveLength(0)
      }),
  )

  it.effect(
    "Unit 1: AstGateCache.decide flags catch-cause-interrupts-only (effect-laws) and unisolated-dot-harness-test-write (test-integrity)",
    () =>
      Effect.gen(function* () {
        // 1. catch-cause-interrupts-only in non-test file
        const catchCauseReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/src/catch-cause.ts"),
              packageTag: AstGatePackageTag.make("infra"),
              content: AstSourceContent.make(
                'import {Effect} from "effect"\n' +
                  "export const op = Effect.catchCause(Effect.succeed(1), (cause) =>\n" +
                  "  Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(cause),\n" +
                  ")\n",
              ),
            },
          ],
        })
        expect(catchCauseReport.verdict).toBe("violated")
        const catchCauseViolations = catchCauseReport.violations.filter(
          (v) => v.rule === "catch-cause-interrupts-only",
        )
        expect(catchCauseViolations).toHaveLength(1)
        expect(catchCauseViolations[0]?.category).toBe("effect-laws")

        // 1b. Cause.hasInterrupts(cause) inside catchCause is allowed
        const cleanCatchCauseReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/src/catch-cause-clean.ts"),
              packageTag: AstGatePackageTag.make("infra"),
              content: AstSourceContent.make(
                'import {Effect} from "effect"\n' +
                  "export const op = Effect.catchCause(Effect.succeed(1), (cause) =>\n" +
                  "  Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(cause),\n" +
                  ")\n",
              ),
            },
          ],
        })
        expect(
          cleanCatchCauseReport.violations.filter((v) => v.rule === "catch-cause-interrupts-only"),
        ).toHaveLength(0)

        // 2. unisolated-dot-harness-test-write in test file
        const testWriteReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/test/leak.test.ts"),
              packageTag: AstGatePackageTag.make("test"),
              content: AstSourceContent.make(
                'import {saveGraphSnapshot} from "@harness/graph"\n' +
                  'export const t = () => saveGraphSnapshot({}, ".harness/graph-snapshot.json")\n',
              ),
            },
          ],
        })
        expect(testWriteReport.verdict).toBe("violated")
        const testWriteViolations = testWriteReport.violations.filter(
          (v) => v.rule === "unisolated-dot-harness-test-write",
        )
        expect(testWriteViolations).toHaveLength(1)
        expect(testWriteViolations[0]?.category).toBe("test-integrity")

        // 2b. writeFileSync directly to .harness/ in test file is flagged
        const fsWriteReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/test/fs-leak.test.ts"),
              packageTag: AstGatePackageTag.make("test"),
              content: AstSourceContent.make(
                'import fs from "node:fs"\n' +
                  'export const t = () => fs.writeFileSync(".harness/leak.json", "{}")\n',
              ),
            },
          ],
        })
        expect(
          fsWriteReport.violations.filter((v) => v.rule === "unisolated-dot-harness-test-write"),
        ).toHaveLength(1)

        // 2c. Writing to tmp directory in test file is allowed (including join(tmpDir, ".harness/..."))
        const cleanTestWriteReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/test/clean.test.ts"),
              packageTag: AstGatePackageTag.make("test"),
              content: AstSourceContent.make(
                'import * as path from "node:path"\n' +
                  'import {saveGraphSnapshot, syncToOmnigraphAndSnapshot} from "@harness/graph"\n' +
                  "export const t = (tmpDir: string) => {\n" +
                  '  saveGraphSnapshot({}, path.join(tmpDir, ".harness", "graph-snapshot.json"))\n' +
                  '  syncToOmnigraphAndSnapshot({}, { snapshotPath: path.join(tmpDir, ".harness/test-snapshot.json") })\n' +
                  '  return classifyFileWrite(".harness/verify-stamp.json")\n' +
                  "}\n",
              ),
            },
          ],
        })
        expect(
          cleanTestWriteReport.violations.filter(
            (v) => v.rule === "unisolated-dot-harness-test-write",
          ),
        ).toHaveLength(0)

        // 2d. Gate Promotion 1: syncToOmnigraphAndSnapshot({ snapshotPath: ".harness/..." }), writeTextSync, appendFileSync, appendTextSync, writeTextWithModeSync, path.join/resolve(process.cwd(), ".harness..."), and empty/dot relative join/concat evasions
        const evasionWriteReport = yield* AstGateCache.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/domain/test/evasion-write.test.ts"),
              packageTag: AstGatePackageTag.make("test"),
              content: AstSourceContent.make(
                'import * as path from "node:path"\n' +
                  'export const t1 = () => syncToOmnigraphAndSnapshot({}, { snapshotPath: ".harness/test-snapshot.json" })\n' +
                  'export const t2 = (io: any) => io.writeTextSync(".harness/a.json", "{}")\n' +
                  'export const t3 = (fsMod: any) => fsMod.appendFileSync(".harness/b.log", "x")\n' +
                  'export const t4 = (io: any) => io.appendTextSync(`.harness/c.log`, "x")\n' +
                  'export const t5 = (io: any) => io.writeTextWithModeSync(".harness/d.json", "{}", 0o600)\n' +
                  'export const t6 = path.join(process.cwd(), ".harness/sync-test-snapshot.json")\n' +
                  'export const t7 = path.resolve(process.cwd(), ".harness", "resolved.json")\n' +
                  'export const t8 = (fsMod: any) => fsMod.writeFileSync(path.join("", ".harness", "empty-base.json"), "{}")\n' +
                  'export const t9 = (io: any) => io.writeTextSync("./" + ".harness/concat.json", "{}")\n',
              ),
            },
          ],
        })
        expect(
          evasionWriteReport.violations.filter(
            (v) => v.rule === "unisolated-dot-harness-test-write",
          ),
        ).toHaveLength(9)
      }),
  )

  it.effect(
    "RFC-0007 Step 4: every production .ts file in libs/ and apps/ respects tiered LOC budgets and passes SelfDogfooding.decide, harness-mcp has no zod, and syntax-bans has no isInternalHarnessFile",
    () =>
      Effect.gen(function* () {
        const testDir = dirname(fileURLToPath(import.meta.url))
        const repoRoot = resolve(testDir, "../../../..")

        const collectedAbsFiles = collectModularPluginFiles(repoRoot, testHostIo)
        const relFiles = collectedAbsFiles.map((abs) => relative(repoRoot, abs).replace(/\\/g, "/"))

        expect(relFiles.length).toBeGreaterThanOrEqual(100)
        expect(relFiles.some((f) => f.startsWith("libs/"))).toBe(true)
        expect(relFiles.some((f) => f.startsWith("apps/"))).toBe(true)
        expect(
          relFiles.some(
            (f) =>
              f.endsWith(".test.ts") ||
              f.endsWith(".spec.ts") ||
              f.endsWith(".d.ts") ||
              f.endsWith(".config.ts") ||
              f.includes("/test/") ||
              f.includes("/dist/") ||
              f.includes("/node_modules/") ||
              f.includes("/repos/"),
          ),
        ).toBe(false)

        const fileInputs = collectedAbsFiles.map((absPath, idx) => ({
          filePath: AstSourceFilePath.make(relFiles[idx]!),
          content: AstSourceContent.make(readFileSync(absPath, "utf8")),
        }))

        const report = yield* SelfDogfooding.decide({
          files: fileInputs,
          maxPluginFileLines: MaxPluginFileLines.make(800),
          failOnViolation: false,
        })

        expect(report.inspectedFileCount).toBe(fileInputs.length)
        expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([])
        expect(report.verdict).toBe("clean")

        const mcpPkgSchema = Schema.fromJsonString(
          Schema.Struct({
            dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
            devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          }),
        )
        const mcpPkg = yield* Schema.decodeEffect(mcpPkgSchema)(
          readFileSync(join(repoRoot, "apps", "harness-mcp", "package.json"), "utf8"),
        )
        expect(mcpPkg.dependencies?.zod).toBeUndefined()
        expect(mcpPkg.devDependencies?.zod).toBeUndefined()

        const syntaxBansSrc = readFileSync(
          join(repoRoot, "tools", "oxlint", "syntax-bans.js"),
          "utf8",
        )
        expect(syntaxBansSrc).not.toMatch(/\bisInternalHarnessFile\b/)
      }),
    15_000,
  )

  it.effect(
    "RFC-0007 Step 4 edge cases: enforces tiered limits across .tsx & nested subdirs and fails on facade-star-reexport when failOnViolation is true",
    () =>
      Effect.gen(function* () {
        const makeLines = (n: number) =>
          Array.from({ length: n }, (_, i) => `export const x${i} = ${i}`).join("\n")
        const tieredReport = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("apps/harness-cli/src/commands/sub/ui.tsx"),
              content: AstSourceContent.make(makeLines(651)),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/extractor/nested/helper.ts"),
              content: AstSourceContent.make(makeLines(500)),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/graph/src/engine/nested/solver.ts"),
              content: AstSourceContent.make(makeLines(701)),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
          failOnViolation: false,
        })
        expect(tieredReport.verdict).toBe("violated")
        expect(tieredReport.violations.map((v) => v.file)).toEqual([
          "apps/harness-cli/src/commands/sub/ui.tsx",
          "libs/harness/graph/src/extractor/nested/helper.ts",
          "libs/harness/graph/src/engine/nested/solver.ts",
        ])

        const starErr = yield* Effect.flip(
          SelfDogfooding.decide({
            files: [
              {
                filePath: AstSourceFilePath.make("libs/harness/graph/src/type-extractor.ts"),
                content: AstSourceContent.make('export * from "./extractor/compiler-session.js"\n'),
              },
            ],
            failOnViolation: true,
          }),
        )
        expect(starErr._tag).toBe("SelfDogfoodingViolationError")
        expect(starErr.violations.some((v) => v.rule === "facade-star-reexport")).toBe(true)
      }),
  )

  it.effect(
    "F-10: decideSelfDogfooding enforces exact tiered LOC boundaries (250/251, 499/500, 650/651, 800/801)",
    () =>
      Effect.gen(function* () {
        const makeLines = (n: number) =>
          Array.from({ length: n }, (_, i) => `export const b${i} = ${i}`).join("\n")

        const boundaryCases: ReadonlyArray<{
          readonly filePath: string
          readonly limit: number
        }> = [
          { filePath: "apps/harness-cli/src/index.ts", limit: 250 },
          { filePath: "libs/harness/graph/src/extractor/foo.ts", limit: 499 },
          { filePath: "apps/harness-cli/src/commands/foo.ts", limit: 650 },
          { filePath: "libs/sample/domain/src/foo.ts", limit: 800 },
        ]

        for (const { filePath, limit } of boundaryCases) {
          const atLimitReport = yield* decideSelfDogfooding({
            files: [
              {
                filePath: AstSourceFilePath.make(filePath),
                content: AstSourceContent.make(makeLines(limit)),
              },
            ],
            maxPluginFileLines: MaxPluginFileLines.make(800),
            failOnViolation: false,
          })
          expect(atLimitReport.verdict, `${filePath} at ${limit} lines`).toBe("clean")
          expect(atLimitReport.violations).toHaveLength(0)

          const overLimitReport = yield* decideSelfDogfooding({
            files: [
              {
                filePath: AstSourceFilePath.make(filePath),
                content: AstSourceContent.make(makeLines(limit + 1)),
              },
            ],
            maxPluginFileLines: MaxPluginFileLines.make(800),
            failOnViolation: false,
          })
          expect(overLimitReport.verdict, `${filePath} at ${limit + 1} lines`).toBe("violated")
          expect(overLimitReport.violations).toHaveLength(1)
          expect(overLimitReport.violations[0]?.rule).toBe("file-line-budget-exceeded")
          expect(overLimitReport.violations[0]?.file).toBe(filePath)
        }
      }),
  )

  it.effect(
    "F-10: visitSourceFileSinglePass flags unscoped-effect-run in sample infra testing.ts/memory.ts while exempting libs/es/infra/src/memory.ts",
    () =>
      Effect.sync(() => {
        const sourceText =
          'import {Effect} from "effect"\nexport const runIt = () => Effect.runPromise(Effect.succeed(1))\n'
        const infraTag = AstGatePackageTag.make("infra")

        const sampleTestingPath = "libs/sample/infra/src/testing.ts"
        const sampleTestingViolations = visitSourceFileSinglePass(
          ts.createSourceFile(sampleTestingPath, sourceText, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(sampleTestingPath),
          infraTag,
        )
        expect(sampleTestingViolations.some((v) => v.rule === "unscoped-effect-run")).toBe(true)

        const sampleMemoryPath = "libs/sample/infra/src/memory.ts"
        const sampleMemoryViolations = visitSourceFileSinglePass(
          ts.createSourceFile(sampleMemoryPath, sourceText, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(sampleMemoryPath),
          infraTag,
        )
        expect(sampleMemoryViolations.some((v) => v.rule === "unscoped-effect-run")).toBe(true)

        const esMemoryPath = "libs/es/infra/src/memory.ts"
        const esMemoryDisallowedViolations = visitSourceFileSinglePass(
          ts.createSourceFile(esMemoryPath, sourceText, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(esMemoryPath),
          infraTag,
        )
        expect(esMemoryDisallowedViolations.some((v) => v.rule === "unscoped-effect-run")).toBe(
          true,
        )

        const esMemoryDieOnly = [
          'import {Effect} from "effect"',
          'export const fail = () => Effect.runSync(Effect.die("fatal"))',
        ].join("\n")
        const esMemoryDieViolations = visitSourceFileSinglePass(
          ts.createSourceFile(esMemoryPath, esMemoryDieOnly, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(esMemoryPath),
          infraTag,
        )
        expect(esMemoryDieViolations.some((v) => v.rule === "unscoped-effect-run")).toBe(false)
      }),
  )

  it.effect(
    "REQ-1.3: visitSourceFileSinglePass flags catch-cause-interrupts-only, unisolated-dot-harness-test-write, and node-sqlite-in-infra on libs/harness/ paths without exemption",
    () =>
      Effect.sync(() => {
        const infraTag = AstGatePackageTag.make("infra")
        const domainTag = AstGatePackageTag.make("domain")
        const testTag = AstGatePackageTag.make("test")

        const interruptPath = "libs/harness/gates/src/sample-interrupt.ts"
        const interruptSrc =
          'import {Effect} from "effect"\nexport const bad = Effect.succeed(1).pipe(Effect.catchCause((c) => Cause.hasInterruptsOnly(c) ? Effect.fail("int") : Effect.fail("err")))\n'
        const interruptViolations = visitSourceFileSinglePass(
          ts.createSourceFile(interruptPath, interruptSrc, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(interruptPath),
          domainTag,
        )
        expect(interruptViolations.some((v) => v.rule === "catch-cause-interrupts-only")).toBe(true)

        const dotHarnessTestPath = "libs/harness/gates/test/unsafe-write.test.ts"
        const dotHarnessSrc =
          'import {writeFileSync} from "node:fs"\nexport const w = () => writeFileSync(".harness/verify-stamp.json", "{}")\n'
        const dotHarnessViolations = visitSourceFileSinglePass(
          ts.createSourceFile(dotHarnessTestPath, dotHarnessSrc, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(dotHarnessTestPath),
          testTag,
        )
        expect(
          dotHarnessViolations.some((v) => v.rule === "unisolated-dot-harness-test-write"),
        ).toBe(true)

        const nodeSqlitePath = "libs/harness/infra/src/bad-sqlite.ts"
        const nodeSqliteSrc =
          'import {DatabaseSync} from "node:sqlite"\nexport const d = DatabaseSync\n'
        const nodeSqliteViolations = visitSourceFileSinglePass(
          ts.createSourceFile(nodeSqlitePath, nodeSqliteSrc, ts.ScriptTarget.Latest, true),
          AstSourceFilePath.make(nodeSqlitePath),
          infraTag,
        )
        expect(nodeSqliteViolations.some((v) => v.rule === "node-sqlite-in-infra")).toBe(true)
      }),
  )

  it.effect(
    "AST hardening: silent-catch-defect, ignored-chmod-permission, and expanded catch-cause-interrupts-only",
    () =>
      Effect.gen(function* () {
        // 1. silent-catch-defect flags silent handler, allows reporting handlers
        const silentDefectPath = AstSourceFilePath.make("libs/harness/gates/src/silent-defect.ts")
        const silentDefectSrc = AstSourceContent.make(
          'import {Effect} from "effect"\n' +
            "export const bad = Effect.succeed(1).pipe(Effect.catchDefect(() => Effect.void))\n" +
            "export const okStderr = Effect.succeed(1).pipe(Effect.catchDefect((d) => { process.stderr.write(String(d)); return Effect.void }))\n" +
            "export const okLog = Effect.succeed(1).pipe(Effect.catchDefect((d) => Effect.logWarning(String(d))))\n" +
            "export const okReport = Effect.succeed(1).pipe(Effect.catchDefect((d) => Effect.succeed(makeLspExceptionReport(d))))\n",
        )
        const silentAstReport = yield* AstGateCache.decide({
          files: [{ filePath: silentDefectPath, content: silentDefectSrc }],
        })
        const silentViolations = silentAstReport.violations.filter(
          (v) => v.rule === "silent-catch-defect",
        )
        expect(silentViolations).toHaveLength(1)
        expect(silentViolations[0]?.line).toBe(2)

        const silentDogfoodReport = yield* decideSelfDogfooding({
          files: [{ filePath: silentDefectPath, content: silentDefectSrc }],
        })
        expect(
          silentDogfoodReport.violations.filter((v) => v.rule === "silent-catch-defect"),
        ).toHaveLength(1)

        // 2. ignored-chmod-permission flags Effect.ignore / Effect.orElseSucceed on chmodSync/fchmodSync, allows fail-closed
        const chmodPath = AstSourceFilePath.make("libs/harness/gates/src/chmod-hardening.ts")
        const chmodSrc = AstSourceContent.make(
          'import {chmodSync,fchmodSync} from "node:fs"\n' +
            'import {Effect} from "effect"\n' +
            'export const badIgnore = Effect.sync(() => chmodSync("/tmp/x", 0o600)).pipe(Effect.ignore)\n' +
            "export const badOrElse = Effect.sync(() => fchmodSync(3, 0o600)).pipe(Effect.orElseSucceed(() => undefined))\n" +
            'export const okFailClosed = Effect.try({ try: () => chmodSync("/tmp/x", 0o600), catch: (e) => e })\n',
        )
        const chmodAstReport = yield* AstGateCache.decide({
          files: [{ filePath: chmodPath, content: chmodSrc }],
        })
        expect(
          chmodAstReport.violations.filter((v) => v.rule === "ignored-chmod-permission"),
        ).toHaveLength(2)

        const chmodDogfoodReport = yield* decideSelfDogfooding({
          files: [{ filePath: chmodPath, content: chmodSrc }],
        })
        expect(
          chmodDogfoodReport.violations.filter((v) => v.rule === "ignored-chmod-permission"),
        ).toHaveLength(2)

        // 3. Expanded catch-cause-interrupts-only flags Effect.runPromiseExit(...).then(...) and Effect.runSyncExit(...)
        const exitInspectPath = AstSourceFilePath.make("libs/harness/gates/src/exit-inspect.ts")
        const exitInspectSrc = AstSourceContent.make(
          'import {Effect,Exit} from "effect"\n' +
            "export const badPromiseExit = Effect.runPromiseExit(Effect.succeed(1)).then((exit) =>\n" +
            "  Exit.isFailure(exit) ? Cause.hasInterruptsOnly(exit.cause) : false,\n" +
            ")\n" +
            "export const badSyncExit = () => {\n" +
            "  const exit = Effect.runSyncExit(Effect.succeed(1))\n" +
            "  return Exit.isFailure(exit) ? Cause.hasInterruptsOnly(exit.cause) : false\n" +
            "}\n" +
            "export const okPureHelper = (cause: Cause.Cause<unknown>) => Cause.hasInterruptsOnly(cause)\n",
        )
        const exitAstReport = yield* AstGateCache.decide({
          files: [{ filePath: exitInspectPath, content: exitInspectSrc }],
        })
        const exitViolations = exitAstReport.violations.filter(
          (v) => v.rule === "catch-cause-interrupts-only",
        )
        expect(exitViolations).toHaveLength(2)

        const exitDogfoodReport = yield* decideSelfDogfooding({
          files: [{ filePath: exitInspectPath, content: exitInspectSrc }],
        })
        expect(
          exitDogfoodReport.violations.filter((v) => v.rule === "catch-cause-interrupts-only"),
        ).toHaveLength(2)
      }),
  )

  // ---------------------------------------------------------------------------
  // 5 · Phase 5D Hexagonal Self-Dogfooding & AstGateCache Permanent Gates
  // ---------------------------------------------------------------------------

  it.effect(
    "REQ-5.1: SelfDogfooding.decide enforces no-global-mutable-cache while allowing static lookup collections",
    () =>
      Effect.gen(function* () {
        const badPath = AstSourceFilePath.make("libs/harness/gates/src/mutable-cache.ts")
        const badSrc = AstSourceContent.make(
          "let counter = 0\n" +
            "const cache = new Map()\n" +
            "const seen = new Set()\n" +
            "const weak = new WeakMap()\n" +
            'const mutatedSet = new Set(["a"])\n' +
            'export const touch = () => { counter += 1; mutatedSet.add("b"); return { cache, seen, weak, counter } }\n',
        )
        const badReport = yield* decideSelfDogfooding({
          files: [{ filePath: badPath, content: badSrc }],
        })
        const badHits = badReport.violations.filter((v) => v.rule === "no-global-mutable-cache")
        expect(badHits).toHaveLength(5)

        const goodPath = AstSourceFilePath.make("libs/harness/gates/src/static-lookup.ts")
        const goodSrc = AstSourceContent.make(
          'const STATIC_SET = new Set(["a", "b"])\n' +
            'const STATIC_MAP = new Map([["a", 1]])\n' +
            "export const lookup = (k: string) => STATIC_SET.has(k) ? STATIC_MAP.get(k) : undefined\n",
        )
        const goodReport = yield* decideSelfDogfooding({
          files: [{ filePath: goodPath, content: goodSrc }],
        })
        expect(
          goodReport.violations.filter((v) => v.rule === "no-global-mutable-cache"),
        ).toHaveLength(0)
      }),
  )

  it.effect(
    "REQ-5.2: SelfDogfooding.decide enforces no-node-builtins-outside-infra outside */infra/src/*",
    () =>
      Effect.gen(function* () {
        const srcContent = AstSourceContent.make(
          'import {readFileSync} from "node:fs"\n' +
            'export { tmpdir } from "os"\n' +
            "export const read = (p: string) => readFileSync(p, 'utf8')\n",
        )

        const nonInfraReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/x.ts"),
              content: srcContent,
            },
          ],
        })
        expect(
          nonInfraReport.violations.filter((v) => v.rule === "no-node-builtins-outside-infra"),
        ).toHaveLength(2)

        const infraReport = yield* decideSelfDogfooding({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/x.ts"),
              content: srcContent,
            },
          ],
        })
        expect(
          infraReport.violations.filter((v) => v.rule === "no-node-builtins-outside-infra"),
        ).toHaveLength(0)
      }),
  )
})
