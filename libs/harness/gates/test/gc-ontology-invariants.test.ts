import { describe, expect, it } from "@effect/vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { SyncHostIo } from "@harness/service/host-io"
import { buildHarnessGraph, ts } from "@harness/graph"
import {
  AstSourceContent,
  AstSourceFilePath,
  NxTierTag,
  PackageDependencyName,
  PackageManifestName,
  PackageManifestPath,
} from "@harness/contract"
import { analyzeSqliteMigratorFromRecordAst } from "../src/plugins/sqlite-migrator-ast.js"
import { visitSourceFileSinglePass } from "../src/plugins/ast-gate-visitors.js"
import { decideSelfDogfooding } from "../src/plugins/self-dogfooding-plugin.js"
import { decideHarnessTierTopology } from "../src/plugins/harness-tier-topology.js"
import { loadGovernanceDocsChecked } from "../src/plugins/gc/gc-helpers.js"
import { evaluateHookFastpathImportClosure } from "../src/plugins/gc/gc-hook-fastpath.js"
import { evaluateInfraSqlAndSqliteHygiene } from "../src/plugins/gc/gc-infra-sql-hygiene.js"
import { extractGateRuleIdsFromSources } from "../src/plugins/gc/gc-rule-digest.js"
import { type GcFinding } from "../src/plugins/gc/gc-workspace-io.js"
import {
  decideOntologyInvariants,
  evaluateDocTruthPlugin,
  evaluatePackageAndMigrationPlugin,
  type GovernanceDocReference,
} from "../src/index.js"
import { testHostIo } from "./helpers/test-host-io.js"

describe("Harness Gates: Ontology Invariants", () => {
  describe("decideOntologyInvariants (OntologyInvariants.decide)", () => {
    it.effect("flags Unwanted behaviour requirement prose referencing undeclared *Error", () =>
      Effect.gen(function* () {
        const graph = buildHarnessGraph({
          earsSpecs: [
            {
              id: "sample:SPEC-0001",
              title: "Cart",
              status: "accepted",
              path: "libs/sample/docs/specs/0001.md",
              enforcedByFiles: [],
              referencedSpans: [],
              referencedServices: [],
              referencedErrors: ["DeclaredError"],
            },
          ],
          errors: [{ errorTag: "DeclaredError", file: "libs/sample/contract/src/index.ts" }],
        })

        const doc: GovernanceDocReference = {
          id: "sample:SPEC-0001",
          docPath: "libs/sample/docs/specs/0001.md",
          status: "accepted",
          referencedErrors: ["DeclaredError"],
          markdown: `---
id: sample:SPEC-0001
title: Cart
status: accepted
date: 2026-10-30
enforced_by:
  - libs/sample/domain/src/index.ts
errors:
  - DeclaredError
---

# sample:SPEC-0001: Cart

## Requirements

### 1 · Cart Operations
**Source:** domain logic

| ID | Pattern | Requirement | Effect Symbol | Verification |
| --- | --- | --- | --- | --- |
| REQ-1.1 | Unwanted behaviour | **If** checkout fails, **then** the engine **shall** fail with UndeclaredCartError. | DeclaredError | test |
`,
        }

        const report = yield* decideOntologyInvariants({
          graph,
          governanceDocs: [doc],
        })

        expect(report.clean).toBe(false)
        const finding = report.findings.find(
          (f) =>
            f.kind === "ontology-if-then-error-mismatch" &&
            f.message.includes('references error "UndeclaredCartError"'),
        )
        expect(finding).toBeDefined()
        expect(finding?.nodeId).toBe("sample:SPEC-0001:REQ-1.1")
        expect(finding?.message).toBe(
          'Unwanted behaviour requirement REQ-1.1 prose references error "UndeclaredCartError" which does not exist in referencedErrors or the workspace graph.',
        )
      }),
    )

    it.effect(
      "emits unreadable-workspace-file, inline-test-ddl-bypassing-migrations, and doc-truth findings",
      () =>
        Effect.gen(function* () {
          const tempDir = mkdtempSync(join(tmpdir(), "gc-selftrust-"))
          try {
            mkdirSync(join(tempDir, "libs/sample/infra/src"), { recursive: true })
            mkdirSync(join(tempDir, "libs/sample/infra/migrations"), { recursive: true })
            mkdirSync(join(tempDir, "libs/sample/infra/test"), { recursive: true })
            mkdirSync(join(tempDir, "adapters/claude-code/rules"), { recursive: true })
            mkdirSync(join(tempDir, "adapters/antigravity/plugins/effect-harness/rules"), {
              recursive: true,
            })

            writeFileSync(
              join(tempDir, "libs/sample/infra/package.json"),
              JSON.stringify({ name: "@sample/infra", nx: { tags: ["type:infra"] } }),
            )
            writeFileSync(join(tempDir, "libs/sample/infra/project.json"), "{bad json")
            writeFileSync(join(tempDir, "libs/sample/infra/src/index.ts"), "export const ok = 1\n")
            writeFileSync(
              join(tempDir, "libs/sample/infra/migrations/0001_init.sql"),
              "CREATE TABLE t (id TEXT PRIMARY KEY);\n",
            )
            writeFileSync(
              join(tempDir, "libs/sample/infra/test/bypass.test.ts"),
              'export const ddl = "CREATE TABLE t (id TEXT PRIMARY KEY)"\n',
            )
            writeFileSync(
              join(tempDir, "README.md"),
              "See `@harness/nonexistent`, `harness/bogus-rule`, `libs/missing/file.ts`.\n",
            )
            writeFileSync(join(tempDir, "AGENTS.md"), "## Rules\nA\n## Rules\nB\n")
            writeFileSync(join(tempDir, "adapters/claude-code/rules/AGENTS.md"), "## Drifted\n")
            writeFileSync(
              join(tempDir, "adapters/claude-code/hooks.json"),
              JSON.stringify({
                hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] },
              }),
            )

            const failingIo = {
              ...testHostIo,
              readTextSync: (p: string) => {
                if (p.endsWith("libs/sample/infra/src/index.ts")) {
                  throw new Error("EACCES: permission denied")
                }
                return testHostIo.readTextSync(p)
              },
            }

            const pkgFindings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: failingIo,
            })
            expect(pkgFindings.some((f) => f.kind === "unreadable-workspace-file")).toBe(true)
            expect(
              pkgFindings.some(
                (f) =>
                  f.kind === "architecture-policy-violation" &&
                  f.nodeId === "libs/sample/infra/project.json:corrupt-manifest",
              ),
            ).toBe(true)
            expect(pkgFindings.some((f) => f.kind === "inline-test-ddl-bypassing-migrations")).toBe(
              true,
            )

            const docFindings = evaluateDocTruthPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: failingIo,
            })
            expect(docFindings.some((f) => f.kind === "doc-unknown-package-name")).toBe(true)
            expect(docFindings.some((f) => f.kind === "doc-unknown-rule-id")).toBe(true)
            expect(docFindings.some((f) => f.kind === "doc-missing-file-path")).toBe(true)
            expect(docFindings.some((f) => f.kind === "agents-duplicate-section")).toBe(true)
            expect(docFindings.some((f) => f.kind === "adapter-rules-drift")).toBe(true)
            expect(docFindings.some((f) => f.kind === "hook-timeout-parity")).toBe(true)
          } finally {
            rmSync(tempDir, { recursive: true, force: true })
          }
        }),
    )

    it("closes SqliteMigrator.fromRecord AST bypasses (namespace import, unresolved spread, duplicates, gaps)", () => {
      const unresolvedImport = analyzeSqliteMigratorFromRecordAst({
        filePath: "libs/sample/infra/src/m.ts",
        content: `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nimport {importedMigrations} from "./other.js";\nexport const m = SqliteMigrator.fromRecord({ ...importedMigrations });`,
      })
      expect(
        unresolvedImport.keyIssues.some((i) =>
          i.message.includes("Unresolved spread '...importedMigrations'"),
        ),
      ).toBe(true)

      const onlyParam = analyzeSqliteMigratorFromRecordAst({
        filePath: "libs/sample/infra/src/m.ts",
        content: `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nexport const make = (extra: Record<string, unknown>) => SqliteMigrator.fromRecord({ ...extra });`,
      })
      expect(
        onlyParam.keyIssues.some((i) => i.message.includes("Unresolved spread '...extra'")),
      ).toBe(true)

      const paramPlusStatic = analyzeSqliteMigratorFromRecordAst({
        filePath: "libs/sample/infra/src/m.ts",
        content: `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nexport const make = (extra: Record<string, unknown>) => SqliteMigrator.fromRecord({ "1_init": "ok", ...extra });`,
      })
      expect(paramPlusStatic.keyIssues).toHaveLength(0)

      const dupPrefix = analyzeSqliteMigratorFromRecordAst({
        filePath: "libs/sample/infra/src/m.ts",
        content: `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nexport const m = SqliteMigrator.fromRecord({ "1_a": "x", "1_b": "y" });`,
      })
      expect(
        dupPrefix.keyIssues.some((i) =>
          i.message.includes("Duplicate migration version prefix '1_'"),
        ),
      ).toBe(true)

      const startAtTwo = analyzeSqliteMigratorFromRecordAst({
        filePath: "libs/sample/infra/src/m.ts",
        content: `import {SqliteMigrator} from "@effect/sql-sqlite-do";\nexport const m = SqliteMigrator.fromRecord({ "2_start": "x" });`,
      })
      expect(
        startAtTwo.keyIssues.some((i) =>
          i.message.includes("Non-contiguous migration version sequence"),
        ),
      ).toBe(true)

      const nsSqlDo = analyzeSqliteMigratorFromRecordAst({
        filePath: "libs/sample/infra/src/m.ts",
        content: `import * as SqlDo from "@effect/sql-sqlite-do";\nexport const m = SqlDo.SqliteMigrator.fromRecord({ "badKey": "x" });`,
      })
      expect(nsSqlDo.fromRecordCallCount).toBe(1)
      expect(nsSqlDo.keyIssues.some((i) => i.key === "badKey")).toBe(true)
    })

    it("catches unscoped-effect-run namespace, computed-element, and destructuring bypasses in ast-gate-visitors", () => {
      const checkFile = (code: string) => {
        const sf = ts.createSourceFile(
          "libs/sample/domain/src/bypass.ts",
          code,
          ts.ScriptTarget.Latest,
          true,
        )
        return visitSourceFileSinglePass(sf, "libs/sample/domain/src/bypass.ts", "domain")
      }
      expect(
        checkFile(
          `import * as Fx from "effect"; export const x = Fx.Effect.runSync(Fx.Effect.succeed(1));`,
        ).some((v) => v.rule === "unscoped-effect-run"),
      ).toBe(true)
      expect(
        checkFile(
          `import {Effect} from "effect"; export const x = Effect["runSync"](Effect.succeed(1));`,
        ).some((v) => v.rule === "unscoped-effect-run"),
      ).toBe(true)
      expect(
        checkFile(
          `import * as Fx from "effect"; export const x = Fx["Effect"]["runSync"](Fx.Effect.succeed(1));`,
        ).some((v) => v.rule === "unscoped-effect-run"),
      ).toBe(true)
      expect(
        checkFile(`export const run = (rt: any) => rt["runSync"](1);`).some(
          (v) => v.rule === "unscoped-effect-run",
        ),
      ).toBe(true)
      expect(
        checkFile(
          `import {Effect} from "effect"; const { runSync } = Effect; export const x = runSync(Effect.succeed(1));`,
        ).some((v) => v.rule === "unscoped-effect-run"),
      ).toBe(true)
      expect(
        checkFile(
          `import {Effect} from "effect"; const { runPromise: rp } = Effect; export const x = rp(Effect.succeed(1));`,
        ).some((v) => v.rule === "unscoped-effect-run"),
      ).toBe(true)
      expect(
        checkFile(
          `import * as Fx from "effect"; const { Effect: { runSync: r } } = Fx; export const x = r(Fx.Effect.succeed(1));`,
        ).some((v) => v.rule === "unscoped-effect-run"),
      ).toBe(true)
    })

    it.effect(
      "catches pipe/match silent-gate-fs-fallback and exposes loadGovernanceDocsChecked",
      () =>
        Effect.gen(function* () {
          const pipeCode = `import {Result} from "effect"; export const f = (io: any) => Result.try(() => io.readTextSync("a")).pipe(Result.getOrElse(() => ""));`
          const matchCode = `import {Result} from "effect"; ; export const f = (io: any) => match(Result.try(() => io.readTextSync("a"))).with({ _tag: "Success" }, ({ success }) => success).with({ _tag: "Failure" }, () => "").exhaustive();`

          const sfPipe = ts.createSourceFile(
            "libs/harness/gates/src/example.ts",
            pipeCode,
            ts.ScriptTarget.Latest,
            true,
          )
          const sfMatch = ts.createSourceFile(
            "libs/harness/gates/src/example.ts",
            matchCode,
            ts.ScriptTarget.Latest,
            true,
          )
          expect(
            visitSourceFileSinglePass(sfPipe, "libs/harness/gates/src/example.ts").some(
              (v) => v.rule === "silent-gate-fs-fallback",
            ),
          ).toBe(true)
          expect(
            visitSourceFileSinglePass(sfMatch, "libs/harness/gates/src/example.ts").some(
              (v) => v.rule === "silent-gate-fs-fallback",
            ),
          ).toBe(true)

          const dogfoodReport = yield* decideSelfDogfooding({
            files: [
              {
                filePath: AstSourceFilePath.make("libs/harness/gates/src/pipe-ex.ts"),
                content: AstSourceContent.make(pipeCode),
              },
              {
                filePath: AstSourceFilePath.make("libs/harness/gates/src/match-ex.ts"),
                content: AstSourceContent.make(matchCode),
              },
            ],
          })
          expect(
            dogfoodReport.violations.filter((v) => v.rule === "silent-gate-fs-fallback").length,
          ).toBeGreaterThanOrEqual(2)

          const checkedEmpty = loadGovernanceDocsChecked("/non/existent/repo/root", testHostIo)
          expect(checkedEmpty.docs).toEqual([])
          expect(checkedEmpty.findings).toEqual([])
        }),
    )

    it.effect(
      "enforces peerDependencies tier checks and infra->app name fallback when app is omitted from manifests",
      () =>
        Effect.gen(function* () {
          const tempDir = mkdtempSync(join(tmpdir(), "harness-peer-dep-test-"))
          try {
            const domDir = join(tempDir, "libs", "sample", "domain")
            mkdirSync(join(domDir, "src"), { recursive: true })
            writeFileSync(
              join(domDir, "package.json"),
              JSON.stringify({
                name: "@harness/sample-domain",
                nx: { tags: ["type:domain"] },
                peerDependencies: { alchemy: "*" },
              }),
            )
            writeFileSync(join(domDir, "src", "index.ts"), "export const x = 1;\n")
            const findings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: testHostIo,
            })
            expect(
              findings.some(
                (f) =>
                  f.kind === "architecture-policy-violation" &&
                  f.nodeId.includes("forbidden-domain-dependency") &&
                  f.message.includes("alchemy"),
              ),
            ).toBe(true)
          } finally {
            rmSync(tempDir, { recursive: true, force: true })
          }

          const topologyReport = yield* decideHarnessTierTopology({
            manifests: [
              {
                manifestPath: PackageManifestPath.make("libs/sample/infra/package.json"),
                packageName: PackageManifestName.make("@harness/sample-infra"),
                nxTags: [NxTierTag.make("type:infra")],
                scopeTags: [],
                dependencyNames: [PackageDependencyName.make("harness-cli")],
                nonRuntimeDependencyNames: [],
              },
            ],
            serviceFiles: [],
            workspaceSourceFiles: [],
          })
          expect(
            topologyReport.violations.some(
              (v) => v.rule === "forbidden-infra-dependency" && v.message.includes("harness-cli"),
            ),
          ).toBe(true)
        }),
    )

    it.effect(
      "Gate A (hook-fastpath-forbidden-import): flags transitive typescript or @harness/graph barrel imports in hook fastpath while allowing type-only and cluster-resolver imports",
      () =>
        Effect.gen(function* () {
          const tempDir = mkdtempSync(join(tmpdir(), "harness-fastpath-closure-"))
          try {
            mkdirSync(join(tempDir, "libs", "harness", "graph", "src"), { recursive: true })
            mkdirSync(join(tempDir, "libs", "harness", "gates", "src"), { recursive: true })
            mkdirSync(join(tempDir, "apps", "harness-cli", "src", "commands"), {
              recursive: true,
            })

            writeFileSync(
              join(tempDir, "libs", "harness", "graph", "src", "index.ts"),
              'import ts from "typescript"\nexport const g = ts.version\n',
            )
            writeFileSync(
              join(tempDir, "libs", "harness", "graph", "src", "cluster-resolver.ts"),
              'import type { Type } from "typescript"\nexport const resolveCluster = (): Type | undefined => undefined\n',
            )
            writeFileSync(
              join(tempDir, "libs", "harness", "gates", "src", "hook-fastpath.ts"),
              'import type * as Graph from "@harness/graph"\nexport type G = Graph.HarnessGraph\nexport const ok = () => "allow"\n',
            )
            writeFileSync(
              join(tempDir, "apps", "harness-cli", "src", "commands", "guard-helper.ts"),
              'import { resolveCluster } from "@harness/graph/cluster-resolver"\nexport const check = () => resolveCluster()\n',
            )
            writeFileSync(
              join(tempDir, "apps", "harness-cli", "src", "commands", "guard-and-route.command.ts"),
              'import { check } from "./guard-helper.js"\nexport const run = () => check()\n',
            )

            const cleanFindings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: testHostIo,
            })
            expect(
              cleanFindings.filter((f) => f.kind === "hook-fastpath-forbidden-import"),
            ).toEqual([])

            // Evade via transitive relative helper importing @harness/graph barrel
            writeFileSync(
              join(tempDir, "apps", "harness-cli", "src", "commands", "guard-helper.ts"),
              'import { g } from "@harness/graph"\nexport const check = () => g\n',
            )
            writeFileSync(
              join(tempDir, "libs", "harness", "gates", "src", "hook-fastpath.ts"),
              'import { createSourceFile } from "typescript"\nexport const parse = createSourceFile\n',
            )
            const dirtyFindings = yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: testHostIo,
            })
            const closureFindings = dirtyFindings.filter(
              (f) => f.kind === "hook-fastpath-forbidden-import",
            )
            expect(closureFindings.map((f) => f.location)).toContain(
              "apps/harness-cli/src/commands/guard-and-route.command.ts",
            )
            expect(closureFindings.map((f) => f.location)).toContain(
              "libs/harness/gates/src/hook-fastpath.ts",
            )

            // Evade via ts-morph, import = require("typescript"), await import("typescript"), require("@harness/graph"), and @harness/graph/type-extractor
            mkdirSync(join(tempDir, "libs", "harness", "decision", "src"), { recursive: true })
            writeFileSync(
              join(tempDir, "libs", "harness", "decision", "src", "hook-fastpath.ts"),
              [
                'import tsReq = require("typescript")',
                'import { Project } from "ts-morph"',
                'export const f = async () => { const g = require("@harness/graph"); const t = await import("typescript"); return { tsReq, Project, g, t } }',
              ].join("\n") + "\n",
            )
            writeFileSync(
              join(tempDir, "apps", "harness-cli", "src", "commands", "session-fastpath.ts"),
              'import { extract } from "@harness/graph/type-extractor"\nexport const s = () => extract\n',
            )
            const evasionFindings = (yield* evaluatePackageAndMigrationPlugin({
              graph: buildHarnessGraph({}),
              workspaceRoot: tempDir,
              hostIo: testHostIo,
            })).filter((f) => f.kind === "hook-fastpath-forbidden-import")
            const decisionTraces = evasionFindings
              .filter((f) => f.location === "libs/harness/decision/src/hook-fastpath.ts")
              .map((f) => f.message)
              .join("\n")
            expect(decisionTraces).toContain("-> typescript")
            expect(decisionTraces).toContain("-> ts-morph")
            expect(decisionTraces).toContain("-> @harness/graph")
            expect(
              evasionFindings.some(
                (f) =>
                  f.location === "apps/harness-cli/src/commands/session-fastpath.ts" &&
                  f.message.includes("@harness/graph/type-extractor"),
              ),
            ).toBe(true)
          } finally {
            rmSync(tempDir, { recursive: true, force: true })
          }
        }),
    )

    it.effect("flags banned root drizzle deps and covers extractGateRuleIdsFromSources", () =>
      Effect.gen(function* () {
        expect(
          extractGateRuleIdsFromSources(
            "",
            "",
            "",
            "",
            'export const GcFindingKind = Schema.Literals(["hook-fastpath-forbidden-import", "unmanaged-sql-ddl"])',
          ),
        ).toEqual(["hook-fastpath-forbidden-import", "unmanaged-sql-ddl"])

        const tempDir = mkdtempSync(join(tmpdir(), "gc-drizzle-root-"))
        try {
          writeFileSync(
            join(tempDir, "package.json"),
            JSON.stringify({
              name: "drizzle-root-test",
              dependencies: { effect: "4.0.0", "drizzle-orm": "0.30.0" },
              devDependencies: { "drizzle-kit": "0.20.0" },
            }),
          )
          const findings = yield* evaluatePackageAndMigrationPlugin({
            graph: buildHarnessGraph({}),
            workspaceRoot: tempDir,
            hostIo: testHostIo,
          })
          expect(
            findings
              .filter((f) => f.nodeId.startsWith("package.json:forbidden-core-dependency:"))
              .map((f) => f.nodeId)
              .sort(),
          ).toEqual([
            "package.json:forbidden-core-dependency:drizzle-kit",
            "package.json:forbidden-core-dependency:drizzle-orm",
          ])
        } finally {
          rmSync(tempDir, { recursive: true, force: true })
        }
      }),
    )

    it("resolves dynamic workspace package exports, AST runtime specifiers, and IO errors in evaluateHookFastpathImportClosure", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "gc-fastpath-exports-"))
      try {
        mkdirSync(join(tempDir, "libs", "custom", "str-pkg", "src"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "custom", "obj-pkg", "src"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "custom", "blank-name"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "custom", "no-name"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "custom", "node_modules", "ignored"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "node_modules", "ignored"), { recursive: true })
        mkdirSync(join(tempDir, "apps", "harness-cli", "src"), { recursive: true })

        writeFileSync(join(tempDir, "libs", "README.md"), "# ignore file\n")
        writeFileSync(join(tempDir, "libs", "custom", "NOTES.md"), "# ignore file\n")
        writeFileSync(
          join(tempDir, "libs", "custom", "blank-name", "package.json"),
          JSON.stringify({ name: "   ", exports: "./dist/index.js" }),
        )
        writeFileSync(
          join(tempDir, "libs", "custom", "no-name", "package.json"),
          JSON.stringify({ exports: null }),
        )
        writeFileSync(
          join(tempDir, "libs", "custom", "node_modules", "ignored", "package.json"),
          JSON.stringify({ name: "@custom/str-pkg", exports: "./bad.js" }),
        )
        writeFileSync(
          join(tempDir, "libs", "node_modules", "ignored", "package.json"),
          JSON.stringify({ name: "@custom/ignored", exports: "./bad.js" }),
        )

        writeFileSync(
          join(tempDir, "libs", "custom", "str-pkg", "package.json"),
          JSON.stringify({ name: "@custom/str-pkg", exports: "./dist/index.js" }),
        )
        writeFileSync(
          join(tempDir, "libs", "custom", "str-pkg", "src", "index.ts"),
          'import "typescript/lib/str-pkg"\n',
        )

        writeFileSync(
          join(tempDir, "libs", "custom", "obj-pkg", "package.json"),
          JSON.stringify({
            name: "@custom/obj-pkg",
            exports: {
              ".": "./dist/index.js",
              "./imp": { import: "./dist/imp.mjs" },
              "./def": { import: 123, default: "./dist/def.js" },
              "./non-str-def": { default: 456 },
              "./null-exp": null,
              "./empty-exp": {},
              "./missing": "./dist/nope.js",
            },
          }),
        )
        writeFileSync(
          join(tempDir, "libs", "custom", "obj-pkg", "src", "index.ts"),
          [
            'import DefTs, { type Program } from "typescript/lib/default-plus-type"',
            'import { type PureT } from "typescript/lib/pure-inline-type"',
            'export * from "typescript/lib/star-reexport"',
            "export const x = DefTs",
            "export { x }",
          ].join("\n") + "\n",
        )
        writeFileSync(
          join(tempDir, "libs", "custom", "obj-pkg", "src", "imp.ts"),
          [
            'export { type T2 } from "typescript/lib/reexport-inline-type"',
            'export { val } from "typescript/lib/reexport-val"',
          ].join("\n") + "\n",
        )
        writeFileSync(
          join(tempDir, "libs", "custom", "obj-pkg", "src", "def.ts"),
          ['import eqTs = require("typescript/lib/imp-eq")', "export const d = { eqTs }"].join(
            "\n",
          ) + "\n",
        )
        writeFileSync(
          join(tempDir, "apps", "harness-cli", "src", "index.ts"),
          [
            'import "@custom/str-pkg"',
            'import { x } from "@custom/obj-pkg"',
            'import { val } from "@custom/obj-pkg/imp"',
            'import { d } from "@custom/obj-pkg/def"',
            'const dynMod = import("typescript/lib/top-dyn")',
            'const propMod = loader.require("typescript/lib/prop-req")',
            'const ignoredMod = loader.load("typescript/lib/not-require")',
            'const ignoredCall = helper("typescript/lib/not-an-import")',
            "export const boot = { x, val, d, dynMod, propMod, ignoredMod, ignoredCall }",
          ].join("\n") + "\n",
        )

        const findings: Array<GcFinding> = []
        evaluateHookFastpathImportClosure(tempDir, testHostIo, findings)
        const joinedMessages = findings.map((f) => f.message).join("\n")
        for (const expectedTrace of [
          "typescript/lib/str-pkg",
          "typescript/lib/default-plus-type",
          "typescript/lib/star-reexport",
          "typescript/lib/reexport-val",
          "typescript/lib/imp-eq",
          "typescript/lib/top-dyn",
          "typescript/lib/prop-req",
        ]) {
          expect(joinedMessages).toContain(expectedTrace)
        }
        expect(joinedMessages).not.toContain("typescript/lib/pure-inline-type")
        expect(joinedMessages).not.toContain("typescript/lib/reexport-inline-type")
        expect(joinedMessages).not.toContain("typescript/lib/not-require")
        expect(joinedMessages).not.toContain("typescript/lib/not-an-import")

        const ioLibsFail: SyncHostIo = {
          ...testHostIo,
          readdirSync: (dir) => {
            if (dir === join(tempDir, "libs")) throw new Error("libs readdir blocked")
            return testHostIo.readdirSync(dir)
          },
        }
        const f1: Array<GcFinding> = []
        evaluateHookFastpathImportClosure(tempDir, ioLibsFail, f1)
        expect(f1.some((f) => f.kind === "unreadable-workspace-file")).toBe(true)

        const ioScopeFail: SyncHostIo = {
          ...testHostIo,
          readdirSync: (dir) => {
            if (dir === join(tempDir, "libs", "custom")) throw new Error("scope readdir blocked")
            return testHostIo.readdirSync(dir)
          },
          readTextSync: (p) => {
            if (p.endsWith("obj-pkg/package.json")) throw new Error("pkg read blocked")
            return testHostIo.readTextSync(p)
          },
        }
        const f2: Array<GcFinding> = []
        evaluateHookFastpathImportClosure(tempDir, ioScopeFail, f2)
        expect(f2.some((f) => f.kind === "unreadable-workspace-file")).toBe(true)

        const ioPkgFail: SyncHostIo = {
          ...testHostIo,
          readTextSync: (p) => {
            if (p.endsWith("obj-pkg/package.json")) throw new Error("pkg read blocked")
            return testHostIo.readTextSync(p)
          },
        }
        const f3: Array<GcFinding> = []
        evaluateHookFastpathImportClosure(tempDir, ioPkgFail, f3)
        expect(f3.some((f) => f.kind === "unreadable-workspace-file")).toBe(true)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("detects unmanaged DDL before migration spans, inline default-table collisions, and cross-file spread gaps", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "gc-sql-hygiene-"))
      try {
        mkdirSync(join(tempDir, "libs", "demo", "infra", "src"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "demo2", "infra", "src"), { recursive: true })
        mkdirSync(join(tempDir, "libs", "demo3", "infra", "src"), { recursive: true })

        const mvOffset = join(tempDir, "libs", "demo", "infra", "src", "mv-offset.ts")
        writeFileSync(
          mvOffset,
          [
            'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
            "const r = sql`CREATE TABLE rogue_mv (id INT)`",
            'const veryLongMigrationVariableNameForSpanOffsetCheckMigrations: Record<string, unknown> = { "1_init": sql`CREATE TABLE ok_mv (id INT)` }',
            "export const mv = { r, veryLongMigrationVariableNameForSpanOffsetCheckMigrations }",
          ].join("\n") + "\n",
        )

        const frOffset = join(tempDir, "libs", "demo", "infra", "src", "fr-offset.ts")
        writeFileSync(
          frOffset,
          [
            'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
            "const r = sql`CREATE TABLE rogue_fr (id INT)`",
            'export const loader = SqliteMigrator.fromRecord<VeryLongGenericMigrationRecordLoaderEntryTypeForSpanOffsetTesting>({ "1_init": sql`CREATE TABLE ok_fr (id INT)` })',
            "export const fr = r",
          ].join("\n") + "\n",
        )

        const fDemo: Array<GcFinding> = []
        evaluateInfraSqlAndSqliteHygiene(tempDir, "demo", [mvOffset, frOffset], testHostIo, fDemo)
        expect(
          fDemo.some(
            (f) =>
              f.kind === "unmanaged-sql-ddl" && f.location === "libs/demo/infra/src/mv-offset.ts",
          ),
        ).toBe(true)
        expect(
          fDemo.some(
            (f) =>
              f.kind === "unmanaged-sql-ddl" && f.location === "libs/demo/infra/src/fr-offset.ts",
          ),
        ).toBe(true)

        const inlineA = join(tempDir, "libs", "demo2", "infra", "src", "inline-a.ts")
        const inlineB = join(tempDir, "libs", "demo2", "infra", "src", "inline-b.ts")
        writeFileSync(
          inlineA,
          'import { SqliteMigrator } from "@effect/sql-sqlite-do"\nexport const runA = SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "1_alpha": sql`SELECT 1` }) })\n',
        )
        writeFileSync(
          inlineB,
          'import { SqliteMigrator } from "@effect/sql-sqlite-do"\nexport const runB = SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "1_beta": sql`SELECT 1` }) })\n',
        )
        const fDemo2: Array<GcFinding> = []
        evaluateInfraSqlAndSqliteHygiene(tempDir, "demo2", [inlineA, inlineB], testHostIo, fDemo2)
        expect(
          fDemo2.some((f) => f.nodeId.includes("shared-default-migrations-table:1_beta")),
        ).toBe(true)

        const baseFile = join(tempDir, "libs", "demo3", "infra", "src", "base.ts")
        const consumerFile = join(tempDir, "libs", "demo3", "infra", "src", "consumer.ts")
        writeFileSync(baseFile, 'export const sharedBaseMigrations = { "1_one": 1 }\n')
        writeFileSync(
          consumerFile,
          'import { sharedBaseMigrations } from "./base.js"\nexport const consumerMigrations = { ...sharedBaseMigrations, "3_three": 3 }\n',
        )
        const fDemo3: Array<GcFinding> = []
        evaluateInfraSqlAndSqliteHygiene(
          tempDir,
          "demo3",
          [baseFile, consumerFile],
          testHostIo,
          fDemo3,
        )
        expect(
          fDemo3.some((f) => f.nodeId === "libs/demo3/infra/src/consumer.ts:sequence-gap-1-3"),
        ).toBe(true)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })
})
