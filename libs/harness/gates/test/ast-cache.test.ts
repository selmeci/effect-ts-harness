import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AstSourceContent, AstSourceFilePath, GateRuleVersion } from "@harness/contract"
import { decideAstGateCache, evaluateAstGateFiles, makeAstGateCacheKey } from "../src/ast-cache.js"
import { analyzeSqliteMigratorFromRecordAst } from "../src/plugins/sqlite-migrator-ast.js"

describe("AstGateCache Drizzle interpolated template specifier ban", () => {
  it.effect(
    "bans interpolated template specifiers in dynamic import and require across src/ and test/",
    () =>
      Effect.gen(function* () {
        const report = yield* decideAstGateCache({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/src/dynamic-drizzle.ts"),
              content: AstSourceContent.make(
                [
                  'const driver = "pg"',
                  "export const load = async () => await import(`drizzle-orm/${driver}`)",
                  "export const loadKit = () => require(`drizzle-kit/${driver}`)",
                ].join("\n"),
              ),
            },
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/test/dynamic-drizzle.test.ts"),
              content: AstSourceContent.make(
                [
                  'const driver = "sqlite"',
                  "export const loadTest = async () => await import(`drizzle-orm/${driver}`)",
                  "export const loadKitTest = () => require(`drizzle-kit/${driver}`)",
                ].join("\n"),
              ),
            },
          ],
        })

        expect(report.verdict).toBe("violated")
        const drizzleViolations = report.violations.filter(
          (v) => v.rule === "banned-drizzle-import",
        )
        expect(drizzleViolations.length).toBe(4)
        expect(
          drizzleViolations.filter(
            (v) =>
              v.file === "libs/sample/infra/src/dynamic-drizzle.ts" && v.category === "syntax-bans",
          ).length,
        ).toBe(2)
        expect(
          drizzleViolations.filter(
            (v) =>
              v.file === "libs/sample/infra/test/dynamic-drizzle.test.ts" &&
              v.category === "test-integrity",
          ).length,
        ).toBe(2)
      }),
  )

  it.effect("flags invalid generative/chat clef endpoints in src/ files", () =>
    Effect.gen(function* () {
      const report = yield* decideAstGateCache({
        files: [
          {
            filePath: AstSourceFilePath.make("libs/sample/infra/src/bad-clef.ts"),
            content: AstSourceContent.make(
              'export const badUrl = "http://localhost:11434/api/generate"\n',
            ),
          },
        ],
      })

      expect(report.verdict).toBe("violated")
      const clefViolations = report.violations.filter((v) => v.rule === "invalid-clef-endpoint")
      expect(clefViolations.length).toBe(1)
      expect(clefViolations[0]?.message).toContain("[invalid-clef-endpoint]")
    }),
  )

  it.effect(
    "emits invalid-migrator-record-key via AstGateCache.decide and AST analyzer for bad/empty/dynamic fromRecord",
    () =>
      Effect.gen(function* () {
        const source = [
          'import { SqliteMigrator } from "@effect/sql-sqlite-do"',
          "const localMigrations = {",
          '  init_bad: "CREATE TABLE t (id INT)",',
          '  "1_good": { table_name: "ok", sql: "DROP TABLE legacy" },',
          "} as const",
          "export const m1 = SqliteMigrator.fromRecord(localMigrations)",
          "export const m2 = SqliteMigrator.fromRecord({})",
          "export const m3 = SqliteMigrator.fromRecord(getDynamic())",
        ].join("\n")

        const analysis = analyzeSqliteMigratorFromRecordAst({
          filePath: "libs/sample/infra/src/migrator.ts",
          content: source,
        })
        expect(analysis.fromRecordCallCount).toBe(3)
        expect(analysis.checkedKeyCount).toBe(2)
        expect(analysis.keyIssues.length).toBe(3)
        expect(analysis.unsafeSqlIssues.length).toBe(1)

        const report = yield* decideAstGateCache({
          files: [
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/src/migrator.ts"),
              content: AstSourceContent.make(source),
            },
            {
              filePath: AstSourceFilePath.make("libs/sample/infra/src/migrator.ts"),
              content: AstSourceContent.make(source),
            },
          ],
        })
        expect(report.verdict).toBe("violated")
        expect(report.parsedFileCount).toBe(1)
        expect(
          report.violations.filter((v) => v.rule === "invalid-migrator-record-key").length,
        ).toBe(3)
        expect(report.violations.filter((v) => v.rule === "unsafe-sql-migration").length).toBe(1)
      }),
  )

  it.effect(
    "keys AST cache by HARNESS_GATE_RULE_VERSION and separates different ruleVersion evaluations",
    () =>
      Effect.sync(() => {
        expect(makeAstGateCacheKey("a.ts", "infra")).toContain("ast-gates-v9")
        const store = new Map()
        const r1 = evaluateAstGateFiles(
          {
            files: [
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/x.ts"),
                content: AstSourceContent.make("export const x = 1\n"),
              },
            ],
            ruleVersion: GateRuleVersion.make("ast-gates-v4"),
          },
          undefined,
          store,
        )
        const r2 = evaluateAstGateFiles(
          {
            files: [
              {
                filePath: AstSourceFilePath.make("libs/sample/domain/src/x.ts"),
                content: AstSourceContent.make("export const x = 1\n"),
              },
            ],
            ruleVersion: GateRuleVersion.make("ast-gates-v7"),
          },
          undefined,
          store,
        )
        expect(r1.parsedFileCount).toBe(1)
        expect(r2.parsedFileCount).toBe(1)
        expect(r2.cacheHitCount).toBe(0)
      }),
  )
})
