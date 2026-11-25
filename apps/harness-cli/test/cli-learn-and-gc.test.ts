import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "@harness/decision"
import { runCli } from "./run-cli-helper.js"
import { syntaxBans } from "./helpers/syntax-bans-fixture.js"

describe("harness-cli v2 learn, gc & report", () => {
  describe("learn", () => {
    it("records friction events from route misses and guard escalations, proposes actions via LearnProposalV1, and clears with --clear", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-learn-"))
      try {
        const reviewLayer = makeMockDecisionModelLayer({
          fitsAnyProb: 0.3,
          blockLabel: "review",
          learnActionableProb: 0.92,
          learnTargetLabel: "agent-pattern",
        })

        await runCli(["route", "Stream large R2 CSV with Effect Stream"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        await runCli(["route", "Stream large R2 CSV with Effect Stream"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        await runCli(["guard", "node custom-migration-check.mjs"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })

        const learnRes = await runCli(["learn"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(learnRes.exitCode).toBe(0)
        const payload = JSON.parse(learnRes.stdout)
        expect(payload.totalEvents).toBe(3)
        expect(payload.cleared).toBe(false)
        expect(payload.proposals).toHaveLength(2)
        expect(payload.proposals[0]).toMatchObject({
          kind: "route_miss",
          summary: "Stream large R2 CSV with Effect Stream",
          occurrences: 2,
          target: "agent-pattern",
          actionable: true,
        })

        const clearRes = await runCli(["learn", "--clear"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(clearRes.exitCode).toBe(0)
        expect(JSON.parse(clearRes.stdout).cleared).toBe(true)

        const afterClear = await runCli(["learn"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(JSON.parse(afterClear.stdout)).toEqual({
          totalEvents: 0,
          proposals: [],
          cleared: false,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("F-12.a: learn --clear exits 1 and preserves friction events when learned-slices.json is corrupt", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-learn-corrupt-"))
      try {
        const reviewLayer = makeMockDecisionModelLayer({
          fitsAnyProb: 0.3,
          blockLabel: "review",
          learnActionableProb: 0.92,
          learnTargetLabel: "agent-pattern",
        })

        await runCli(["route", "Unhandled pattern"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        writeFileSync(join(dir, ".harness", "learned-slices.json"), "{corrupt-json", "utf8")

        const clearRes = await runCli(["learn", "--clear"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(clearRes.exitCode).toBe(1)
        const payload = JSON.parse(clearRes.stdout)
        expect(payload.cleared).toBe(false)
        expect(payload.totalEvents).toBe(1)
        expect(clearRes.stderr).toContain("failed to decode")

        rmSync(join(dir, ".harness", "learned-slices.json"), { force: true })
        const after = await runCli(["learn"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(JSON.parse(after.stdout).totalEvents).toBe(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("F-12.a: learn --clear exits 1 and preserves friction events when decideRuleSynthesizer returns rejectedRules", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-learn-rejected-"))
      try {
        const reviewLayer = makeMockDecisionModelLayer({
          fitsAnyProb: 0.3,
          blockLabel: "review",
          learnActionableProb: 0.92,
          learnTargetLabel: "agent-pattern",
        })
        await runCli(["route", "Unhandled pattern"], { repoRoot: dir, decisionLayer: reviewLayer })
        writeFileSync(
          join(dir, ".harness", "learned-slices.json"),
          JSON.stringify({
            slices: [
              {
                taskId: "tcb-reject-01",
                badGraphNodes: ["libs/order/domain/src/order.ts#badFn"],
                badGraphHyperedges: [
                  "libs/order/domain/src/order.ts:calls->libs/order/infra/src/db.ts",
                ],
                goodGraphNodes: ["libs/order/domain/src/order.ts#badFn"],
                goodGraphHyperedges: [
                  "libs/order/domain/src/order.ts:calls->libs/order/contract/src/order.ts",
                ],
                healthyCorpusSnapshots: [],
                targetFiles: ["libs/harness/gates/src/policy.ts"],
              },
            ],
          }),
          "utf8",
        )
        const res = await runCli(["learn", "--clear"], {
          repoRoot: dir,
          decisionLayer: reviewLayer,
        })
        expect(res.exitCode).toBe(1)
        const payload = JSON.parse(res.stdout) as {
          readonly cleared: boolean
          readonly rejectedRules?: ReadonlyArray<{ readonly ruleId: string }>
        }
        expect(payload.cleared).toBe(false)
        expect(payload.rejectedRules?.some((r) => r.ruleId === "tcb-reject-01")).toBe(true)
        expect(res.stderr).toContain("rule synthesis rejected")

        rmSync(join(dir, ".harness", "learned-slices.json"), { force: true })
        const after = await runCli(["learn"], { repoRoot: dir, decisionLayer: reviewLayer })
        expect(JSON.parse(after.stdout).totalEvents).toBe(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("gc and session handoff", () => {
    it("gc reports clean: true on workspace and detects dead TaggedError in temp repo with --strict", async () => {
      const workspaceGc = await runCli(["gc"])
      expect(workspaceGc.exitCode).toBe(0)
      expect(JSON.parse(workspaceGc.stdout)).toEqual({
        clean: true,
        findings: [],
      })

      const dir = mkdtempSync(join(tmpdir(), "harness-cli-gc-"))
      try {
        const srcDir = join(dir, "libs", "sample", "contract", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "index.ts"),
          `import { Schema } from "effect"\nexport class UnusedError extends Schema.TaggedErrorClass<UnusedError>()("UnusedError", {}) {}\n`,
        )

        const strictGc = await runCli(["gc", "--strict"], { repoRoot: dir })
        expect(strictGc.exitCode).toBe(1)
        const report = JSON.parse(strictGc.stdout)
        expect(report.clean).toBe(false)
        expect(report.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "dead-tagged-error",
              nodeId: "UnusedError",
            }),
          ]),
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)

    it("session --format=antigravity injects Context Handoff when active stubs exist", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-handoff-"))
      try {
        const srcDir = join(dir, "libs", "sample", "domain", "src")
        mkdirSync(srcDir, { recursive: true })
        writeFileSync(
          join(srcDir, "index.ts"),
          `import { Effect } from "effect"\nimport { stub } from "@harness/contract"\nexport const pendingFn = Effect.fn("Sample.pendingFn")(function* () { return yield* stub<number, never, never>() })\n`,
        )

        const sess = await runCli(["session", "--format=antigravity"], {
          repoRoot: dir,
          decisionLayer: makeFailingDecisionModelLayer(),
        })
        expect(sess.exitCode).toBe(0)
        const payload = JSON.parse(sess.stdout)
        expect(payload.injectSteps).toHaveLength(1)
        expect(payload.injectSteps[0]).toContain("[Harness Context Handoff]")
        expect(payload.injectSteps[0]).toContain("Sample.pendingFn")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("report", () => {
    it("generates session report JSON, writes markdown and json files, and respects --clear", async () => {
      const dir = mkdtempSync(join(tmpdir(), "harness-cli-report-"))
      try {
        await runCli(["guard", "pnpm test"], { repoRoot: dir })
        await runCli(["route", "Add schema"], {
          repoRoot: dir,
          decisionLayer: makeMockDecisionModelLayer({ fitsAnyProb: 0.9, blockLabel: "effect" }),
        })

        const res = await runCli(["report"], { repoRoot: dir })
        expect(res.exitCode).toBe(0)
        const report = JSON.parse(res.stdout)
        expect(report.totalEvents).toBe(2)
        expect(report.healthScore).toBe(100)
        expect(report.grade).toBe("A")
        expect(report.kpis).toMatchObject({
          firstPassVerify: null,
          verifyAttempts: 0,
          fixUpIterations: 0,
          planBeforeVerify: true,
          prematureDoneAttempts: 0,
          graphDiscoveryCalls: 0,
          graphDiscoveryRatio: 0,
          omnigraphLiveRatio: null,
          guardInterventions: 0,
          frictionCount: 0,
        })
        expect(existsSync(join(dir, ".harness", "session-report.json"))).toBe(true)
        expect(existsSync(join(dir, ".harness", "session-report.md"))).toBe(true)

        const mdRes = await runCli(["report", "--format=markdown"], { repoRoot: dir })
        expect(mdRes.exitCode).toBe(0)
        expect(mdRes.stdout).toContain("# Harness Session Observability Report")
        expect(mdRes.stdout).toContain("Key Performance Indicators")

        const clearRes = await runCli(["report", "--clear"], { repoRoot: dir })
        expect(clearRes.exitCode).toBe(0)
        const clearedReport = JSON.parse(clearRes.stdout)
        expect(clearedReport.totalEvents).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe("syntax-bans & test-integrity oxlint rules: SQLite migrations & effect-laws", () => {
  it("enforces transactional SQLite migrations via SqliteMigrator and validates migration record keys in type:infra", () => {
    // 1. Raw sql`CREATE TABLE ...` in libs/sample/infra/src/repo.ts without importing SqliteMigrator is flagged with unmanaged-sql-ddl
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.TaggedTemplateExpression?.({
        type: "TaggedTemplateExpression",
        tag: { type: "Identifier", name: "sql" },
        quasi: {
          type: "TemplateLiteral",
          quasis: [
            {
              type: "TemplateElement",
              value: {
                raw: "CREATE TABLE raw_table (id INTEGER PRIMARY KEY)",
                cooked: "CREATE TABLE raw_table (id INTEGER PRIMARY KEY)",
              },
            },
          ],
          expressions: [],
        },
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("unmanaged-sql-ddl")
    }

    // 2. When ImportDeclaration for @effect/sql-sqlite-do/SqliteMigrator is present, a sql`CREATE TABLE ...` INSIDE SqliteMigrator.fromRecord({ "1_init_tables": sql`CREATE TABLE ...` }) produces 0 reports, whereas a second stray sql`CREATE TABLE stray ...` node OUTSIDE fromRecord in the same file IS flagged with unmanaged-sql-ddl
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ImportDeclaration?.({
        type: "ImportDeclaration",
        source: { type: "Literal", value: "@effect/sql-sqlite-do/SqliteMigrator" },
        specifiers: [
          {
            type: "ImportSpecifier",
            imported: { type: "Identifier", name: "SqliteMigrator" },
            local: { type: "Identifier", name: "SqliteMigrator" },
          },
        ],
      })
      const insideDdlNode = {
        type: "TaggedTemplateExpression",
        tag: { type: "Identifier", name: "sql" },
        quasi: {
          type: "TemplateLiteral",
          quasis: [
            {
              type: "TemplateElement",
              value: {
                raw: "CREATE TABLE managed_table (id INTEGER PRIMARY KEY)",
                cooked: "CREATE TABLE managed_table (id INTEGER PRIMARY KEY)",
              },
            },
          ],
          expressions: [],
        },
      }
      const strayDdlNode = {
        type: "TaggedTemplateExpression",
        tag: { type: "Identifier", name: "sql" },
        quasi: {
          type: "TemplateLiteral",
          quasis: [
            {
              type: "TemplateElement",
              value: {
                raw: "CREATE TABLE stray_table (id INTEGER PRIMARY KEY)",
                cooked: "CREATE TABLE stray_table (id INTEGER PRIMARY KEY)",
              },
            },
          ],
          expressions: [],
        },
      }
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_init_tables" },
                value: insideDdlNode,
              },
            ],
          },
        ],
      })
      // Inside DDL produces 0 reports
      visitor.TaggedTemplateExpression?.(insideDdlNode)
      expect(reports).toHaveLength(0)

      // Stray DDL produces unmanaged-sql-ddl
      visitor.TaggedTemplateExpression?.(strayDdlNode)
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("unmanaged-sql-ddl")
    }
  })

  it("validates SqliteMigrator.fromRecord migration keys, spread declarations, and duplicate numeric ids", () => {
    // 3. Named migration variable + spread: const aggregateCoreMigrations = { "1_init_tables": eff1, "bad_key_after": eff2 } followed by SqliteMigrator.fromRecord({ ...aggregateCoreMigrations }) flags "bad_key_after" with invalid-migrator-record-key
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.ImportDeclaration?.({
        type: "ImportDeclaration",
        source: { type: "Literal", value: "@effect/sql-sqlite-do/SqliteMigrator" },
        specifiers: [
          {
            type: "ImportSpecifier",
            imported: { type: "Identifier", name: "SqliteMigrator" },
            local: { type: "Identifier", name: "SqliteMigrator" },
          },
        ],
      })
      visitor.VariableDeclarator?.({
        type: "VariableDeclarator",
        id: { type: "Identifier", name: "aggregateCoreMigrations" },
        init: {
          type: "ObjectExpression",
          properties: [
            {
              type: "Property",
              computed: false,
              key: { type: "Literal", value: "1_init_tables" },
              value: { type: "Identifier", name: "eff1" },
            },
            {
              type: "Property",
              computed: false,
              key: { type: "Literal", value: "bad_key_after" },
              value: { type: "Identifier", name: "eff2" },
            },
          ],
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "SpreadElement",
                argument: { type: "Identifier", name: "aggregateCoreMigrations" },
              },
            ],
          },
        ],
      })
      expect(reports.some((r) => r.message.includes("invalid-migrator-record-key"))).toBe(true)
      expect(reports.some((r) => r.message.includes("bad_key_after"))).toBe(true)
    }

    // 4. Uppercase non-snake_case key "1_InitTables" is flagged with invalid-migrator-record-key
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_InitTables" },
                value: { type: "Identifier", name: "effect" },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("invalid-migrator-record-key")
      expect(reports[0]?.message).toContain("1_InitTables")
    }
  })

  it("rejects duplicate SqliteMigrator numeric migration ids and allows sequential snake_case keys", () => {
    // 5. Duplicate numeric IDs "1_first" and "1_duplicate" are flagged with invalid-migrator-record-key
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_first" },
                value: { type: "Identifier", name: "effect1" },
              },
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_duplicate" },
                value: { type: "Identifier", name: "effect2" },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("invalid-migrator-record-key")
      expect(reports[0]?.message).toContain(
        "Duplicate SqliteMigrator.fromRecord migration numeric id '1'",
      )
    }

    // 6. Valid keys "1_init_tables" and "2_add_index" produce 0 reports
    {
      const reports: Array<{ message: string }> = []
      const visitor = syntaxBans.create({
        filename: "/repo/libs/sample/infra/src/repo.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "SqliteMigrator" },
          property: { type: "Identifier", name: "fromRecord" },
        },
        arguments: [
          {
            type: "ObjectExpression",
            properties: [
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "1_init_tables" },
                value: { type: "Identifier", name: "effect1" },
              },
              {
                type: "Property",
                computed: false,
                key: { type: "Literal", value: "2_add_index" },
                value: { type: "Identifier", name: "effect2" },
              },
            ],
          },
        ],
      })
      expect(reports).toHaveLength(0)
    }
  })

  it("flags silent-catch-defect, ignored-chmod-permission, and catch-cause-interrupts-only in runPromiseExit while allowing safe forms", () => {
    // 1. silent-catch-defect: Effect.catchDefect(() => Effect.void) is flagged; reporting/re-fail is allowed
    {
      const reports: Array<{ message: string }> = []
      const silentArg = {
        type: "ArrowFunctionExpression",
        rawSource: "() => Effect.void",
      }
      const visitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/server.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "catchDefect" },
        },
        arguments: [silentArg],
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("silently swallows runtime defects")

      const validReports: Array<{ message: string }> = []
      const validVisitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/server.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          validReports.push(r)
        },
      })
      for (const safeText of [
        "(d) => Effect.logWarning(String(d))",
        "(d) => { process.stderr.write(String(d)); return Effect.void }",
        "(d) => Effect.fail(new DefectError(d))",
        "(d) => Effect.succeed(makeLspExceptionReport(d))",
      ]) {
        validVisitor.CallExpression?.({
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            computed: false,
            object: { type: "Identifier", name: "Effect" },
            property: { type: "Identifier", name: "catchDefect" },
          },
          arguments: [{ type: "ArrowFunctionExpression", rawSource: safeText }],
        })
      }
      expect(validReports).toHaveLength(0)
    }
  })

  it("flags ignored-chmod-permission in Effect.try pipes while allowing fail-closed catch handlers", () => {
    // 2. ignored-chmod-permission: chmodSync/fchmodSync inside .pipe(Effect.ignore / Effect.orElseSucceed) is flagged; fail-closed is allowed
    {
      const reports: Array<{ message: string }> = []
      const pipeParent: Record<string, unknown> = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "eff" },
          property: { type: "Identifier", name: "pipe" },
        },
        rawSource: "Effect.try(() => fs.chmodSync(sock, 0o600)).pipe(Effect.ignore)",
      }
      const tryCall = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "try" },
        },
        parent: pipeParent,
      }
      const chmodNode = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "fs" },
          property: { type: "Identifier", name: "chmodSync" },
        },
        parent: tryCall,
      }
      const visitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/daemon/unix-socket-daemon.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.(chmodNode)
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("Ignoring chmodSync/fchmodSync failure")

      const directIgnoreReports: Array<{ message: string }> = []
      const directIgnoreVisitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/daemon/unix-socket-daemon.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          directIgnoreReports.push(r)
        },
      })
      const orElseParent = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "orElseSucceed" },
        },
      }
      directIgnoreVisitor.CallExpression?.({
        type: "CallExpression",
        callee: { type: "Identifier", name: "fchmodSync" },
        parent: orElseParent,
      })
      expect(directIgnoreReports).toHaveLength(1)
      expect(directIgnoreReports[0]?.message).toContain("Ignoring chmodSync/fchmodSync failure")

      // Fail-closed chmodSync inside Effect.try().pipe(Effect.catch(...)) produces 0 reports
      const safeReports: Array<{ message: string }> = []
      const safeVisitor = syntaxBans.create({
        filename: "/repo/apps/harness-mcp/src/daemon/unix-socket-daemon.ts",
        sourceCode: {
          getText: (node: { rawSource?: string }) => node?.rawSource ?? "",
        },
        report: (r: { message: string }) => {
          safeReports.push(r)
        },
      })
      const safePipeParent = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "eff" },
          property: { type: "Identifier", name: "pipe" },
        },
        rawSource: "Effect.try(() => fs.chmodSync(sock, 0o600)).pipe(Effect.catch(handleErr))",
      }
      safeVisitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "fs" },
          property: { type: "Identifier", name: "chmodSync" },
        },
        parent: safePipeParent,
      })
      expect(safeReports).toHaveLength(0)
    }
  })

  it("flags catch-cause-interrupts-only inside runPromiseExit / runSyncExit while allowing tests and Cause.hasInterrupts", () => {
    // 3. catch-cause-interrupts-only inside Effect.runPromiseExit / Effect.runSyncExit is flagged; test files and Cause.hasInterrupts are allowed
    {
      const reports: Array<{ message: string }> = []
      const runPromiseExitParent = {
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Effect" },
          property: { type: "Identifier", name: "runPromiseExit" },
        },
      }
      const visitor = syntaxBans.create({
        filename: "/repo/libs/harness/gates/src/runner.ts",
        report: (r: { message: string }) => {
          reports.push(r)
        },
      })
      visitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Cause" },
          property: { type: "Identifier", name: "hasInterruptsOnly" },
        },
        parent: runPromiseExitParent,
      })
      expect(reports).toHaveLength(1)
      expect(reports[0]?.message).toContain("Cause.hasInterrupts(cause)")

      const testReports: Array<{ message: string }> = []
      const testVisitor = syntaxBans.create({
        filename: "/repo/libs/harness/gates/test/runner.test.ts",
        report: (r: { message: string }) => {
          testReports.push(r)
        },
      })
      testVisitor.CallExpression?.({
        type: "CallExpression",
        callee: {
          type: "MemberExpression",
          computed: false,
          object: { type: "Identifier", name: "Cause" },
          property: { type: "Identifier", name: "hasInterruptsOnly" },
        },
        parent: runPromiseExitParent,
      })
      expect(testReports).toHaveLength(0)
    }
  })
})
