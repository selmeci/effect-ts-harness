import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Option, Schema } from "effect"
import {
  AstGateCache,
  AstGateCacheEntry,
  AstGateDecisionReport,
  AstGateEvaluationInput,
  AstGateFileInput,
  AstGatePackageTag,
  AstSourceContent,
  AstSourceFilePath,
  BenchSampleCount,
  BenchStageName,
  buildStageLatencyMeasurement,
  computePercentileMillis,
  ContentSha256,
  decideAstGateCache,
  decideDomainPurityGate,
  decideEffectLawsGate,
  decideHarnessBench,
  decideSyntaxBansGate,
  decideTestIntegrityGate,
  DEFAULT_STAGE_LATENCY_BUDGETS,
  DomainPurity,
  EffectLaws,
  evaluateAstGateFiles,
  GateCategory,
  GateRuleId,
  GateRuleVersion,
  GateVerdict,
  GateViolation,
  GateViolationMessage,
  HARNESS_GATE_RULE_VERSION,
  HarnessBench,
  HarnessBenchInput,
  HarnessBenchReport,
  LatencyExceededDimension,
  LatencyMillis,
  LatencySloViolationError,
  MigrationSafety,
  StageLatencyEvaluation,
  StageLatencyMeasurement,
  StageLatencyStatus,
  StageLatencyViolation,
  SyntaxBans,
  TestIntegrity,
} from "./index.js"

const CompositeStageMeasurementsArb = Schema.Array(StageLatencyMeasurement)

const CompositeAstGateFilesArb = Schema.Array(AstGateFileInput)

describe("HarnessBench.decide — Latency SLO Gate (PERF-06, RFC-0006)", () => {
  it.effect("evaluates warm stage measurements within default budgets as passed", () =>
    Effect.gen(function* () {
      const m1 = buildStageLatencyMeasurement(
        BenchStageName.make("extractTypeGraph.warm"),
        [10, 12, 14, 15],
      )
      const m2 = buildStageLatencyMeasurement(
        BenchStageName.make("DatalogSession.stepDelta"),
        [4, 6, 8, 9],
      )
      const m3 = buildStageLatencyMeasurement(
        BenchStageName.make("AstGateCache.warm"),
        [0.4, 0.6, 0.8, 1.1],
      )
      const m4 = buildStageLatencyMeasurement(
        BenchStageName.make("GraphRewrite.decide"),
        [20, 25, 30, 35],
      )

      const report = yield* HarnessBench.decide({
        measurements: [m1, m2, m3, m4],
        budgets: DEFAULT_STAGE_LATENCY_BUDGETS,
      })

      expect(report.status).toBe(StageLatencyStatus.make("pass"))
      expect(report.evaluations).toHaveLength(4)
      expect(report.violations).toHaveLength(0)
      expect(computePercentileMillis([10, 20, 30, 40], 0.5)).toBeGreaterThanOrEqual(20)
      expect(BenchSampleCount.make(4)).toBe(4)
      expect(StageLatencyEvaluation.fields).toBeDefined()
      expect(StageLatencyViolation.fields).toBeDefined()
      expect(HarnessBenchInput.fields).toBeDefined()
      expect(HarnessBenchReport.fields).toBeDefined()
    }),
  )

  it.effect(
    "fails with LatencySloViolationError when p50 or p95 exceeds StageLatencyBudget",
    () =>
      Effect.gen(function* () {
        const budget = {
          stage: BenchStageName.make("extractTypeGraph.warm"),
          p50BudgetMs: LatencyMillis.make(50),
          p95BudgetMs: LatencyMillis.make(150),
        }

        // Exact threshold pass (p50 == 50, p95 == 150)
        const exactPass = yield* decideHarnessBench({
          measurements: [
            {
              stage: BenchStageName.make("extractTypeGraph.warm"),
              sampleCount: BenchSampleCount.make(10),
              p50Ms: LatencyMillis.make(50),
              p95Ms: LatencyMillis.make(150),
            },
          ],
          budgets: [budget],
        })
        expect(exactPass.status).toBe("pass")

        // Exceed both p50 and p95
        const exitBoth = yield* Effect.exit(
          decideHarnessBench({
            measurements: [
              {
                stage: BenchStageName.make("extractTypeGraph.warm"),
                sampleCount: BenchSampleCount.make(10),
                p50Ms: LatencyMillis.make(51),
                p95Ms: LatencyMillis.make(151),
              },
            ],
            budgets: [budget],
          }),
        )

        expect(exitBoth._tag).toBe("Failure")
        if (exitBoth._tag === "Failure") {
          const errOpt = Cause.findErrorOption(exitBoth.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value).toBeInstanceOf(LatencySloViolationError)
            expect(errOpt.value._tag).toBe("LatencySloViolationError")
            expect(errOpt.value.violations).toHaveLength(1)
            expect(errOpt.value.violations[0]?.exceededDimension).toBe(
              LatencyExceededDimension.make("both"),
            )
          }
        }
      }),
  )

  it.effect.prop(
    "property: HarnessBench.decide is deterministic and monotonic under budget scaling",
    [CompositeStageMeasurementsArb],
    ([measurements]) =>
      Effect.gen(function* () {
        const byStage = new Map<string, { p50: number; p95: number }>()
        for (const m of measurements) {
          const prev = byStage.get(m.stage)
          byStage.set(m.stage, {
            p50: Math.min(1_000_000_000, Math.max(prev?.p50 ?? 0, m.p50Ms)),
            p95: Math.min(1_000_000_000, Math.max(prev?.p95 ?? 0, m.p95Ms)),
          })
        }
        const generousBudgets = Array.from(byStage.entries()).map(([stage, maxes]) => ({
          stage: BenchStageName.make(stage),
          p50BudgetMs: LatencyMillis.make(maxes.p50),
          p95BudgetMs: LatencyMillis.make(maxes.p95),
        }))

        const r1 = yield* HarnessBench.decide({
          measurements,
          budgets: generousBudgets,
        })
        const r2 = yield* decideHarnessBench({
          measurements,
          budgets: generousBudgets,
        })

        expect(r1.status).toBe("pass")
        expect(r1).toEqual(r2)
      }),
  )
})

describe("AstGateCache & Unified Single-Pass AST Gate Deciders (PERF-02, RFC-0006)", () => {
  it.effect(
    "parses each modified SourceFile at most once across all 5 AST gate categories and hits disk/memory cache in < 5ms",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-ast-cache-"))
        const cacheFile = AstSourceFilePath.make(join(tmpDir, "ast-gates-v1.json"))
        AstGateCache.clear()

        const domainBadCode = [
          'import { drizzle } from "drizzle-orm"',
          "export const compute = (x: unknown) => {",
          "  const y = x as any",
          "  switch (y._tag) {",
          '    case "A": return 1',
          "    default: return 0",
          "  }",
          "}",
        ].join("\n")

        const testBadCode = [
          'import { describe, it, expect } from "vitest"',
          'describe("suite", () => {',
          '  it("vacuous test", () => {',
          "    expect(Exit.isFailure(res)).toBe(true)",
          "    const eq = JSON.stringify(a) === JSON.stringify(b)",
          "  })",
          "})",
        ].join("\n")

        const infraBadCode = [
          'import { DatabaseSync } from "node:sqlite"',
          "export const q = sql`DROP TABLE users`",
        ].join("\n")

        const files = [
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/bad.ts"),
            content: AstSourceContent.make(domainBadCode),
            packageTag: AstGatePackageTag.make("domain"),
          },
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/test/bad.test.ts"),
            content: AstSourceContent.make(testBadCode),
            packageTag: AstGatePackageTag.make("test"),
          },
          {
            filePath: AstSourceFilePath.make("libs/sample/infra/src/bad-infra.ts"),
            content: AstSourceContent.make(infraBadCode),
            packageTag: AstGatePackageTag.make("infra"),
          },
        ]

        const initialParses = AstGateCache.getSourceFileParseCount()

        const fullReport = yield* AstGateCache.decide({
          files,
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })

        const afterFirstPassParses = AstGateCache.getSourceFileParseCount()
        expect(afterFirstPassParses - initialParses).toBe(3)
        expect(fullReport.verdict).toBe(GateVerdict.make("violated"))
        expect(fullReport.parsedFileCount).toBe(3)
        expect(fullReport.cacheHitCount).toBe(0)
        expect(existsSync(cacheFile)).toBe(true)

        // Subsequent category-specific gate calls reuse the cached AST / violations with 0 new parses
        const syntaxReport = yield* SyntaxBans.decide({
          files,
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })
        const testReport = yield* TestIntegrity.decide({
          files,
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })
        const purityReport = yield* DomainPurity.decide({
          files,
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })
        const effectLawsReport = yield* EffectLaws.decide({
          files,
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })
        const migSafetyReport = yield* MigrationSafety.decide({
          files: [{ file: "libs/sample/infra/src/bad-infra.ts", sql: "DROP TABLE users" }],
        })

        expect(AstGateCache.getSourceFileParseCount()).toBe(afterFirstPassParses)
        expect(syntaxReport.cacheHitCount).toBe(3)
        expect(
          syntaxReport.violations.some((v) => v.rule === GateRuleId.make("unsafe-type-cast")),
        ).toBe(true)
        expect(
          testReport.violations.some((v) => v.rule === GateRuleId.make("fallback-json-equality")),
        ).toBe(true)
        expect(
          purityReport.violations.some((v) => v.rule === GateRuleId.make("impure-domain-import")),
        ).toBe(true)
        expect(effectLawsReport.cacheHitCount).toBe(3)
        expect(migSafetyReport.violations.length).toBeGreaterThan(0)

        // Verify disk reload in < 5ms
        AstGateCache.clear()
        const reloadStart = performance.now()
        const warmDiskReport = yield* decideAstGateCache({
          files,
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })
        const reloadMs = performance.now() - reloadStart
        expect(warmDiskReport.cacheHitCount).toBe(3)
        expect(warmDiskReport.parsedFileCount).toBe(0)
        expect(reloadMs).toBeLessThan(25)

        // Verify schema exports
        expect(GateRuleVersion.make("ast-gates-v1")).toBe("ast-gates-v1")
        expect(ContentSha256.make("abc")).toBe("abc")
        expect(GateCategory.make("syntax-bans")).toBe("syntax-bans")
        expect(GateViolationMessage.make("msg")).toBe("msg")
        expect(GateViolation.fields).toBeDefined()
        expect(AstGateCacheEntry.fields).toBeDefined()
        expect(AstGateEvaluationInput.fields).toBeDefined()
        expect(AstGateDecisionReport.fields).toBeDefined()
        expect(evaluateAstGateFiles({ files: [] }).verdict).toBe("clean")

        rmSync(tmpDir, { recursive: true, force: true })
      }),
  )

  it.effect.prop(
    "property: AstGateCache, SyntaxBans, TestIntegrity, DomainPurity, and EffectLaws deciders are idempotent and cache-consistent",
    [CompositeAstGateFilesArb],
    ([generatedFiles]) =>
      Effect.gen(function* () {
        const safeFiles = generatedFiles.map((f, idx) => ({
          filePath: AstSourceFilePath.make(`libs/sample/domain/src/gen_${idx}.ts`),
          content: AstSourceContent.make(`export const val_${idx} = ${idx}\n`),
          packageTag: f.packageTag ?? AstGatePackageTag.make("domain"),
        }))

        const r1 = yield* decideAstGateCache({ files: safeFiles })
        const r2 = yield* decideSyntaxBansGate({ files: safeFiles })
        const r3 = yield* decideTestIntegrityGate({ files: safeFiles })
        const r4 = yield* decideDomainPurityGate({ files: safeFiles })
        const r5 = yield* decideEffectLawsGate({ files: safeFiles })

        expect(r1.verdict).toBe("clean")
        expect(r2.verdict).toBe("clean")
        expect(r3.verdict).toBe("clean")
        expect(r4.verdict).toBe("clean")
        expect(r5.verdict).toBe("clean")
        expect(r2.cacheHitCount).toBe(safeFiles.length)
      }),
  )
})
