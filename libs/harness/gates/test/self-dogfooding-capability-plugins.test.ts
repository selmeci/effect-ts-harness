import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  inferAstGatePackageTagFromPath,
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

  it.effect("REQ-5.3: SelfDogfooding.decide enforces no-layer-build-in-layer-effect", () =>
    Effect.gen(function* () {
      const filePath = AstSourceFilePath.make("libs/harness/gates/src/layer-build.ts")
      const content = AstSourceContent.make(
        'import {Context,Effect} from "effect"\n' +
          'const Tag = Context.Service<{ value: number }>("Tag")\n' +
          "export const badLayer = Layer.effect(Tag, Effect.gen(function* () {\n" +
          "  const scope = yield* Effect.scope\n" +
          "  return yield* Layer.build(Layer.empty)\n" +
          "}))\n" +
          "export const okProgram = Effect.scoped(Layer.build(Layer.empty))\n",
      )
      const report = yield* decideSelfDogfooding({
        files: [{ filePath, content }],
      })
      expect(
        report.violations.filter((v) => v.rule === "no-layer-build-in-layer-effect"),
      ).toHaveLength(1)
    }),
  )

  it.effect("REQ-5.4: SelfDogfooding.decide enforces no-double-wrapped-effect-fn", () =>
    Effect.gen(function* () {
      const filePath = AstSourceFilePath.make("libs/harness/gates/src/double-wrap.ts")
      const content = AstSourceContent.make(
        'import {Effect} from "effect"\n' +
          'export const badArrow = Effect.fn("badArrow")(() => Effect.gen(function* () { return 1 }))\n' +
          'export const badBlock = Effect.fn("badBlock")((x: number) => { return Effect.gen(function* () { return x }) })\n' +
          "export const badUntraced = Effect.fnUntraced(() => Effect.gen(function* () { return 2 }))\n" +
          'export const okFn = Effect.fn("okFn")(function* () { return 3 })\n' +
          "export const okUntraced = Effect.fnUntraced(function* () { return 4 })\n",
      )
      const report = yield* decideSelfDogfooding({
        files: [{ filePath, content }],
      })
      expect(
        report.violations.filter((v) => v.rule === "no-double-wrapped-effect-fn"),
      ).toHaveLength(3)
    }),
  )

  it.effect(
    "REQ-5.5: AstGateCache.decide reports IfStatement discriminant-branching and unscoped-effect-run on libs/harness/gates/src/dummy-test.ts",
    () =>
      Effect.gen(function* () {
        const filePath = AstSourceFilePath.make("libs/harness/gates/src/dummy-test.ts")
        const content = AstSourceContent.make(
          'import {Effect} from "effect"\n' +
            'type State = { readonly _tag: "A" } | { readonly _tag: "B" }\n' +
            "export const inspect = (s: State) => {\n" +
            '  if (s._tag === "A") {\n' +
            "    return 1\n" +
            "  }\n" +
            "  return 2\n" +
            "}\n" +
            "export const runIt = () => Effect.runSync(Effect.succeed(1))\n",
        )
        const report = yield* AstGateCache.decide({
          files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
        })
        expect(report.violations.filter((v) => v.rule === "discriminant-branching")).toHaveLength(1)
        expect(report.violations.filter((v) => v.rule === "unscoped-effect-run")).toHaveLength(1)
      }),
  )

  it.effect(
    "F-8.3b: SelfDogfooding.decide catches process.env.VITEST (test-env-branch-in-src) and dynamic import('node:fs') (no-node-builtins-outside-infra)",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/bad-env-and-dyn.ts"),
              content: AstSourceContent.make(
                'export const isTest = process.env.VITEST === "true" || process.env["VITEST"] === "1"\n' +
                  'export const loadFs = () => import("node:fs")\n',
              ),
            },
          ],
          failOnViolation: false,
        })
        expect(report.verdict).toBe("violated")
        expect(report.violations.filter((v) => v.rule === "test-env-branch-in-src")).toHaveLength(2)
        expect(
          report.violations.filter((v) => v.rule === "no-node-builtins-outside-infra"),
        ).toHaveLength(1)
      }),
  )

  it.effect(
    "flags silent-gate-fs-fallback for safeFs and Result.getOrElse(Result.try(...readTextSync...), () => '') in libs/harness/gates/src/**",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/plugins/gc/bad.ts"),
              content: AstSourceContent.make(
                [
                  'import {Result} from "effect"',
                  'export const a = safeFs(() => "x", "")',
                  'export const b = Result.getOrElse(Result.try(() => hostIo.readTextSync("x")), () => "")',
                ].join("\n"),
              ),
            },
          ],
          failOnViolation: false,
        })
        expect(report.verdict).toBe("violated")
        expect(report.violations.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(
          2,
        )
      }),
  )

  it.effect(
    "F-12.1 / F-6.1 / S-5.4: enforces bare-cause-has-interrupts, process-env-outside-infra-or-app, and module-scope object property mutation",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/decision/src/bad-checks.ts"),
              content: AstSourceContent.make(
                [
                  "",
                  "const mutableState = { flag: false }",
                  "export const setFlag = () => { mutableState.flag = true }",
                  "export const badCause = (c: Cause.Cause<unknown>) => Cause.hasInterrupts(c)",
                  "export const goodCause = (c: Cause.Cause<unknown>) => Cause.hasInterrupts(c) && !Cause.hasFails(c) && !Cause.hasDies(c)",
                  'export const badEnv = () => process.env["MY_VAR"]',
                ].join("\n"),
              ),
            },
            {
              filePath: AstSourceFilePath.make(
                "libs/harness/contract/src/workspace-and-process.ts",
              ),
              content: AstSourceContent.make(
                "\nexport const isPureInterruptCause = (c: Cause.Cause<unknown>) => Cause.hasInterrupts(c)\n",
              ),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/ok-env.ts"),
              content: AstSourceContent.make('export const okEnv = () => process.env["MY_VAR"]\n'),
            },
          ],
          failOnViolation: false,
        })

        expect(report.verdict).toBe("violated")
        expect(
          report.violations.filter((v) => v.rule === "bare-cause-has-interrupts"),
        ).toHaveLength(1)
        expect(
          report.violations.filter((v) => v.rule === "process-env-outside-infra-or-app"),
        ).toHaveLength(1)
        expect(report.violations.filter((v) => v.rule === "no-global-mutable-cache")).toHaveLength(
          1,
        )
      }),
  )

  it.effect(
    "closes AST false negatives for satisfies/nested/++ mutable caches, computed/destructured process.env, dynamic-harness-import, and point-free/mismatched Cause.hasInterrupts",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/gates/src/evasion-checks.ts"),
              content: AstSourceContent.make(
                [
                  'import {Effect} from "effect"',
                  "type Cache = { count: number; nested: { hits: number } }",
                  "const cache = { count: 0, nested: { hits: 0 } } satisfies Cache",
                  "export const bump = () => {",
                  "  cache.count++",
                  "  cache.nested.hits = 1",
                  "  Object.assign(cache, { count: 2 })",
                  "}",
                  'export const envBracket = () => process["env"]["FOO"]',
                  "export const envDestructure = () => { const { env } = process; return env }",
                  'export const dynImport = () => import("@harness/contract")',
                  'export const dynRequire = () => require("@harness/contract")',
                  "export const pointFreeCause = (eff: Effect.Effect<void>) => eff.pipe(Effect.catchCauseIf(Cause.hasInterrupts, () => Effect.void))",
                  "export const spoofedCause = (c: Cause.Cause<unknown>, other: Cause.Cause<unknown>) => Cause.hasInterrupts(c) && !Cause.hasFails(other) && !Cause.hasDies(c)",
                ].join("\n"),
              ),
            },
          ],
          failOnViolation: false,
        })

        expect(report.verdict).toBe("violated")
        expect(report.violations.filter((v) => v.rule === "no-global-mutable-cache")).toHaveLength(
          3,
        )
        expect(
          report.violations.filter((v) => v.rule === "process-env-outside-infra-or-app"),
        ).toHaveLength(2)
        expect(report.violations.filter((v) => v.rule === "dynamic-harness-import")).toHaveLength(2)
        expect(
          report.violations.filter((v) => v.rule === "bare-cause-has-interrupts"),
        ).toHaveLength(2)
      }),
  )

  it.effect(
    "I-4a: enforces bare-cause-has-interrupts on Cause.hasInterruptsOnly in src/ outside Effect.catchCause while exempting workspace-and-process.ts",
    () =>
      Effect.gen(function* () {
        const report = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/interrupt-checks.ts"),
              content: AstSourceContent.make(
                [
                  'import {Effect,Exit} from "effect"',
                  "",
                  "export const standaloneHelper = (cause: Cause.Cause<unknown>) => Cause.hasInterruptsOnly(cause)",
                  "export const inspectExit = (exit: Exit.Exit<unknown, unknown>) =>",
                  "  match(exit)",
                  '    .with({ _tag: "Failure" }, ({ cause }) => Cause.hasInterruptsOnly(cause))',
                  '    .with({ _tag: "Success" }, () => false)',
                  "    .exhaustive()",
                  "export const pointFreeOnly = (eff: Effect.Effect<void>) => eff.pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.void))",
                ].join("\n"),
              ),
            },
            {
              filePath: AstSourceFilePath.make(
                "libs/harness/contract/src/workspace-and-process.ts",
              ),
              content: AstSourceContent.make(
                "\nexport const isPureInterruptCause = (c: Cause.Cause<unknown>) => Cause.hasInterruptsOnly(c)\n",
              ),
            },
          ],
          failOnViolation: false,
        })

        expect(report.verdict).toBe("violated")
        const interruptViolations = report.violations.filter(
          (v) => v.rule === "bare-cause-has-interrupts",
        )
        expect(interruptViolations).toHaveLength(3)
        expect(
          interruptViolations.every((v) => v.file === "libs/harness/infra/src/interrupt-checks.ts"),
        ).toBe(true)
        expect(interruptViolations.every((v) => v.message.includes("isPureInterruptCause"))).toBe(
          true,
        )
      }),
  )

  it("H-1..H-4: enforces silent-gate-fs-fallback scope, all-optional-contract-struct, test bailouts/vacuous length, and discarded-persistence-result", () => {
    const runAst = (relPath: string, code: string) => {
      const sf = ts.createSourceFile(relPath, code, ts.ScriptTarget.Latest, true)
      return visitSourceFileSinglePass(
        sf,
        AstSourceFilePath.make(relPath),
        inferAstGatePackageTagFromPath(AstSourceFilePath.make(relPath)),
      )
    }

    // H-1: silent-gate-fs-fallback across graph/cli/mcp, exempting compiler-session.ts and /proc/ probes
    const graphFallback = runAst(
      "libs/harness/graph/src/bad-io.ts",
      'import {Result} from "effect"\nexport const f = () => Result.getOrElse(Result.try(() => readTextSync("x")), () => "")\n',
    )
    expect(graphFallback.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(1)

    const procProbe = runAst(
      "apps/harness-mcp/src/proc-probe.ts",
      'import {Result} from "effect"\nexport const p = (procCmdlinePath: string) => Result.getOrElse(Result.try(() => readTextSync(procCmdlinePath)), () => "")\nexport const p2 = () => Result.getOrElse(Result.try(() => readTextSync("/proc/1/cmdline")), () => "")\nexport const p3 = (pid: number) => Result.getOrElse(Result.try(() => readTextSync(`/proc/${pid}/cmdline`)), () => "")\n',
    )
    expect(procProbe.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(0)

    const procDecoy = runAst(
      "apps/harness-mcp/src/proc-decoy.ts",
      'import {Result} from "effect"\nexport const decoy = () => Result.getOrElse(Result.try(() => { const hint = "/proc/"; return readTextSync("secret.txt") }), () => "")\n',
    )
    expect(procDecoy.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(1)

    const compilerSession = runAst(
      "libs/harness/graph/src/extractor/compiler-session.ts",
      'import {Result} from "effect"\nexport const c = () => Result.getOrElse(Result.try(() => readTextSync("x")), () => "")\n',
    )
    expect(compilerSession.filter((v) => v.rule === "silent-gate-fs-fallback")).toHaveLength(0)

    // H-2: all-optional-contract-struct
    const allOptional = runAst(
      "libs/sample/contract/src/bad-struct.ts",
      [
        'import {Schema} from "effect"',
        "export const BadMeta = Schema.Struct({ pid: Schema.optional(Schema.Int), port: Schema.optional(Schema.Int) })",
        "export const GoodMeta = Schema.Struct({ pid: Schema.Int, port: Schema.optional(Schema.Int) })",
      ].join("\n"),
    )
    expect(allOptional.filter((v) => v.rule === "all-optional-contract-struct")).toHaveLength(1)

    // H-3: conditional-port-bind-bailout & vacuous-length-nonnegative-assertion
    const badTest = runAst(
      "libs/sample/domain/test/bad.test.ts",
      [
        "export const t = (bound: boolean, items: ReadonlyArray<string>) => {",
        "  if (!bound) return",
        "  expect(items.length).toBeGreaterThanOrEqual(0)",
        "  expect(items.length).toBeGreaterThanOrEqual(1)",
        "}",
      ].join("\n"),
    )
    expect(badTest.filter((v) => v.rule === "conditional-port-bind-bailout")).toHaveLength(1)
    expect(badTest.filter((v) => v.rule === "vacuous-length-nonnegative-assertion")).toHaveLength(1)

    // H-4: discarded-persistence-result (including void and sequence expression evasion)
    const badPersist = runAst(
      "libs/harness/graph/src/persist.ts",
      [
        "export const p = () => {",
        "  writeGraphHeadMeta()",
        "  updateGraphHeadCursor()",
        "  writeServerMetaAtomic()",
        "  void writeGraphHeadMeta()",
        "  ;(0, writeGraphHeadMeta())",
        "  const ok = writeGraphHeadMeta()",
        "  return ok",
        "}",
      ].join("\n"),
    )
    expect(badPersist.filter((v) => v.rule === "discarded-persistence-result")).toHaveLength(5)
  })

  it("oxlint syntax-bans catches .pipe() all-optional-contract-struct and void/sequence discarded-persistence-result", async () => {
    const pluginMod = (await import(
      new URL("../../../../tools/oxlint/syntax-bans.js", import.meta.url).href
    )) as {
      default: {
        rules: {
          "syntax-bans": {
            create: (
              ctx: unknown,
            ) => Record<string, ((node: Record<string, unknown>) => void) | undefined>
          }
        }
      }
    }
    const syntaxBans = pluginMod.default.rules["syntax-bans"]

    const structReports: Array<{ message: string }> = []
    const contractVisitor = syntaxBans.create({
      filename: "/repo/libs/sample/contract/src/bad-pipe-struct.ts",
      report: (r: { message: string }) => {
        structReports.push(r)
      },
    })
    contractVisitor.ExportNamedDeclaration?.({
      type: "ExportNamedDeclaration",
      declaration: {
        type: "VariableDeclaration",
        declarations: [
          {
            type: "VariableDeclarator",
            id: { type: "Identifier", name: "BadPipeStruct" },
            init: {
              type: "CallExpression",
              callee: {
                type: "MemberExpression",
                computed: false,
                object: {
                  type: "CallExpression",
                  callee: {
                    type: "MemberExpression",
                    computed: false,
                    object: { type: "Identifier", name: "Schema" },
                    property: { type: "Identifier", name: "Struct" },
                  },
                  arguments: [
                    {
                      type: "ObjectExpression",
                      properties: [
                        {
                          type: "Property",
                          key: { type: "Identifier", name: "a" },
                          value: {
                            type: "CallExpression",
                            callee: {
                              type: "MemberExpression",
                              computed: false,
                              object: { type: "Identifier", name: "Schema" },
                              property: { type: "Identifier", name: "optional" },
                            },
                            arguments: [
                              {
                                type: "MemberExpression",
                                computed: false,
                                object: { type: "Identifier", name: "Schema" },
                                property: { type: "Identifier", name: "Int" },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
                property: { type: "Identifier", name: "pipe" },
              },
              arguments: [{ type: "Identifier", name: "someAnnotation" }],
            },
          },
        ],
      },
    })
    expect(structReports.some((r) => r.message.includes("all-optional-contract-struct"))).toBe(true)

    const persistReports: Array<{ message: string }> = []
    const graphVisitor = syntaxBans.create({
      filename: "/repo/libs/harness/graph/src/persist.ts",
      report: (r: { message: string }) => {
        persistReports.push(r)
      },
    })
    graphVisitor.ExpressionStatement?.({
      type: "ExpressionStatement",
      expression: {
        type: "UnaryExpression",
        operator: "void",
        argument: {
          type: "CallExpression",
          callee: { type: "Identifier", name: "writeGraphHeadMeta" },
          arguments: [],
        },
      },
    })
    graphVisitor.ExpressionStatement?.({
      type: "ExpressionStatement",
      expression: {
        type: "SequenceExpression",
        expressions: [
          { type: "Literal", value: 0 },
          {
            type: "CallExpression",
            callee: { type: "Identifier", name: "updateGraphHeadCursor" },
            arguments: [],
          },
        ],
      },
    })
    expect(
      persistReports.filter((r) => r.message.includes("discarded-persistence-result")),
    ).toHaveLength(2)
  })

  it.effect(
    "REQ-1.3: flags process-exit-outside-app and locale-dependent-sort (including evasion forms) in SelfDogfooding.decide",
    () =>
      Effect.gen(function* () {
        const err = yield* Effect.flip(
          SelfDogfooding.decide({
            files: [
              {
                filePath: AstSourceFilePath.make("libs/sample/core/src/bad-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/harness/gates/src/bad-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/harness/decision/src/bad-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/core/src/evade-exit.ts"),
                content: AstSourceContent.make(
                  [
                    'export const e1 = () => process["exit"](1)',
                    "export const e2 = () => globalThis.process.exit(1)",
                    "export const e3 = () => { const { exit } = process; return exit(1) }",
                    "export const e4 = () => { const p = process; return p.exit(1) }",
                    "export const e5 = () => process.reallyExit(1)",
                    "export const e6 = () => Reflect.apply(process.exit, process, [1])",
                  ].join("\n") + "\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/sample/src/ok-exit.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/core/test/ok-exit.test.ts"),
                content: AstSourceContent.make("export const bail = () => process.exit(1)\n"),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/contract/src/bad-sort.ts"),
                content: AstSourceContent.make(
                  "export const sortIds = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b))\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/bad-sort.ts"),
                content: AstSourceContent.make(
                  "export const cmp = (a: string, b: string) => a.localeCompare(b)\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/evade-sort.ts"),
                content: AstSourceContent.make(
                  [
                    'export const s1 = (a: string, b: string) => a["localeCompare"](b)',
                    "export const s2 = (a: string, b: string) => String.prototype.localeCompare.call(a, b)",
                    "export const s3 = (a: string, b: string) => new Intl.Collator().compare(a, b)",
                  ].join("\n") + "\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make(
                  "libs/harness/gates/src/plan-workflow-compiler.ts",
                ),
                content: AstSourceContent.make(
                  "export const cmp = (a: string, b: string) => a.localeCompare(b)\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/ok-sort.ts"),
                content: AstSourceContent.make(
                  "export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/src/bad-promise.ts"),
                content: AstSourceContent.make(
                  'export const bad = Effect.promise(() => import("./mod.js"))\nexport const badBracket = Effect["promise"](() => import("./mod.js"))\n',
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/src/evade-promise.ts"),
                content: AstSourceContent.make(
                  [
                    'import { Effect as Fx } from "effect"',
                    'import * as Eff from "effect"',
                    'import { promise as effPromise } from "effect/Effect"',
                    "const { promise } = Fx",
                    "export const e1 = Fx.promise(() => Promise.resolve(1))",
                    "export const e2 = Eff.Effect.promise(() => Promise.resolve(2))",
                    "export const e3 = effPromise(() => Promise.resolve(3))",
                    "export const e4 = promise(() => Promise.resolve(4))",
                    "export const e5 = Reflect.apply(Fx.promise, Fx, [() => Promise.resolve(5)])",
                  ].join("\n") + "\n",
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/src/good-trypromise.ts"),
                content: AstSourceContent.make(
                  'export const good = Effect.tryPromise({ try: () => import("./mod.js"), catch: (e) => e })\n',
                ),
              },
              {
                filePath: AstSourceFilePath.make("apps/harness-cli/test/ok-promise.test.ts"),
                content: AstSourceContent.make(
                  "export const okTest = Effect.promise(() => Promise.resolve(1))\n",
                ),
              },
            ],
            maxPluginFileLines: MaxPluginFileLines.make(800),
            failOnViolation: true,
          }),
        )

        const exitViolations = err.violations.filter((v) => v.rule === "process-exit-outside-app")
        expect(
          exitViolations.map((v) => v.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ).toEqual([
          "libs/harness/decision/src/bad-exit.ts",
          "libs/harness/gates/src/bad-exit.ts",
          "libs/sample/core/src/bad-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
          "libs/sample/core/src/evade-exit.ts",
        ])

        const sortViolations = err.violations.filter((v) => v.rule === "locale-dependent-sort")
        expect(
          sortViolations.map((v) => v.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ).toEqual([
          "libs/harness/gates/src/plan-workflow-compiler.ts",
          "libs/sample/contract/src/bad-sort.ts",
          "libs/sample/domain/src/bad-sort.ts",
          "libs/sample/domain/src/evade-sort.ts",
          "libs/sample/domain/src/evade-sort.ts",
          "libs/sample/domain/src/evade-sort.ts",
        ])

        const promiseViolations = err.violations.filter(
          (v) => v.rule === "unhandled-effect-promise",
        )
        expect(
          promiseViolations.map((v) => v.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        ).toEqual([
          "apps/harness-cli/src/bad-promise.ts",
          "apps/harness-cli/src/bad-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
          "apps/harness-cli/src/evade-promise.ts",
        ])
      }),
  )

  it.effect(
    "SPEC-0027 REQ-3.1: flags unfenced expectMutation: true calls and permits fenced or exempt lease calls",
    () =>
      Effect.gen(function* () {
        const cleanReport = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/fenced-calls.ts"),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryWithMeta(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryOnce(input: unknown): unknown",
                  "declare const WorkflowStore: { invoke: (i: unknown) => unknown; invokeWithMeta: (i: unknown) => unknown }",
                  "declare const otherClient: { invoke: (i: unknown) => unknown }",
                  "declare const expectedLeaseEpoch: number",
                  "declare const fenceConfig: object",
                  "declare const target: object",
                  "declare const storeTarget: object",
                  "declare const cond: boolean",
                  'export const okRead = invokeWorkflowStoreQuery({ queryName: "wf_get_run", expectMutation: false })',
                  'export const okNoFlag = invokeWorkflowStoreQuery({ queryName: "wf_get_run" })',
                  "export const okNonObj = invokeWorkflowStoreQuery(fenceConfig)",
                  "export const okZeroArg = invokeWorkflowStoreQuery()",
                  'export const okExplicit = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch: expectedLeaseEpoch })',
                  'export const okTemplateProp = invokeWorkflowStoreQuery({ [`queryName`]: "wf_insert_run", ["expectMutation"]: true, [`expectedLeaseEpoch`]: expectedLeaseEpoch })',
                  'export const okShorthand = invokeWorkflowStoreQueryWithMeta({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch })',
                  'export const okFenceSpread = invokeWorkflowStoreQueryOnce({ queryName: "wf_insert_run", expectMutation: true, ...fenceConfig })',
                  'export const okTargetSpread = WorkflowStore.invoke({ queryName: "wf_insert_run", expectMutation: true, ...target })',
                  'export const okStoreTarget = WorkflowStore.invokeWithMeta({ queryName: "wf_insert_run", expectMutation: true, ...storeTarget })',
                  'export const okCondTrue = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, ...(cond ? { expectedLeaseEpoch } : {}) })',
                  'export const okCondFalse = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, ...(cond ? {} : { expectedLeaseEpoch }) })',
                  'export const okObjSpread = invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true, ...({ expectedLeaseEpoch }) })',
                  'export const okLease1 = invokeWorkflowStoreQuery({ queryName: "wf_insert_writer_lease", expectMutation: true })',
                  "export const okLease2 = invokeWorkflowStoreQuery({ queryName: `wf_cas_writer_lease`, expectMutation: true })",
                  'export const okLease3 = invokeWorkflowStoreQuery({ queryName: "wf_refresh_writer_lease", expectMutation: true })',
                  'export const okOtherInvoke = otherClient.invoke({ queryName: "wf_insert_run", expectMutation: true })',
                ].join("\n") + "\n",
              ),
            },
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/offline-maint.ts"),
              content: AstSourceContent.make(
                [
                  "declare function verifyOfflineClusterAccess(): void",
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "export const runOffline = () => {",
                  "  verifyOfflineClusterAccess()",
                  '  return invokeWorkflowStoreQuery({ queryName: "wf_insert_run", expectMutation: true })',
                  "}",
                ].join("\n") + "\n",
              ),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        })
        expect(
          cleanReport.violations.filter((v) => v.rule === "omnigraph-fenced-mutation"),
        ).toEqual([])

        const violatedReport = yield* SelfDogfooding.decide({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/harness/infra/src/unfenced-calls.ts"),
              content: AstSourceContent.make(
                [
                  "declare function invokeWorkflowStoreQuery(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryWithMeta(input: unknown): unknown",
                  "declare function invokeWorkflowStoreQueryOnce(input: unknown): unknown",
                  "declare function buildConfig(): object",
                  "declare const WorkflowStore: { invoke: (i: unknown) => unknown; invokeWithMeta: (i: unknown) => unknown }",
                  "declare const wf_cas_writer_lease: string",
                  "declare const storeConfig: object",
                  "declare const cond: boolean",
                  'export const bad1 = (invokeWorkflowStoreQuery)({ queryName: "wf_insert_run", expectMutation: true })',
                  'export const bad2 = invokeWorkflowStoreQueryWithMeta({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch: undefined })',
                  'export const bad3 = invokeWorkflowStoreQueryOnce({ queryName: "wf_insert_run", expectMutation: true, expectedLeaseEpoch: null })',
                  'export const bad4 = WorkflowStore.invoke({ queryName: "wf_insert_run", expectMutation: true, ...storeConfig })',
                  'export const bad5 = WorkflowStore.invokeWithMeta({ queryName: "wf_insert_run", expectMutation: true, ...(cond ? {} : {}), ...buildConfig() })',
                  "export const bad6 = invokeWorkflowStoreQuery({ queryName: wf_cas_writer_lease, expectMutation: true })",
                ].join("\n") + "\n",
              ),
            },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        })
        const fenceViolations = violatedReport.violations.filter(
          (v) => v.rule === "omnigraph-fenced-mutation",
        )
        expect(fenceViolations).toHaveLength(6)
      }),
  )

  it.effect.prop(
    "SPEC-0027 REQ-3.1 determinism: SelfDogfooding.decide emits deterministic omnigraph-fenced-mutation verdicts",
    {
      spec: Schema.Struct({
        queryName: Schema.Literals(["wf_insert_run", "wf_cas_writer_lease", "wf_update_unit"]),
        fencingMode: Schema.Literals(["explicit", "fenceSpread", "missing"]),
        expectMutation: Schema.Boolean,
      }),
    },
    ({ spec }) =>
      Effect.gen(function* () {
        const fenceField = match(spec.fencingMode)
          .with("explicit", () => ", expectedLeaseEpoch: epoch")
          .with("fenceSpread", () => ", ...fenceConfig")
          .with("missing", () => "")
          .exhaustive()
        const src = AstSourceContent.make(
          `declare function invokeWorkflowStoreQuery(input: unknown): unknown\n` +
            `declare const epoch: number\n` +
            `declare const fenceConfig: object\n` +
            `export const call = invokeWorkflowStoreQuery({ queryName: "${spec.queryName}", expectMutation: ${String(spec.expectMutation)}${fenceField} })\n`,
        )
        const input = {
          files: [
            { filePath: AstSourceFilePath.make("libs/harness/infra/src/prop.ts"), content: src },
          ],
          maxPluginFileLines: MaxPluginFileLines.make(800),
        }
        const first = yield* SelfDogfooding.decide(input)
        const second = yield* SelfDogfooding.decide(input)
        expect(first).toEqual(second)
        const shouldViolate =
          spec.expectMutation &&
          spec.queryName !== "wf_cas_writer_lease" &&
          spec.fencingMode === "missing"
        expect(first.violations.some((v) => v.rule === "omnigraph-fenced-mutation")).toBe(
          shouldViolate,
        )
      }),
  )
})
