import { describe, expect, it } from "@effect/vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
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
  })
})
