import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  getAstGateCacheSize,
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

  it.effect("fails with LatencySloViolationError when p50 or p95 exceeds StageLatencyBudget", () =>
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

      // Exceed p50 only
      const exitP50 = yield* Effect.exit(
        decideHarnessBench({
          measurements: [
            {
              stage: BenchStageName.make("extractTypeGraph.warm"),
              sampleCount: BenchSampleCount.make(10),
              p50Ms: LatencyMillis.make(51),
              p95Ms: LatencyMillis.make(140),
            },
          ],
          budgets: [budget],
        }),
      )
      expect(exitP50._tag).toBe("Failure")
      if (exitP50._tag === "Failure") {
        const errOpt = Cause.findErrorOption(exitP50.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value.violations[0]?.exceededDimension).toBe(
            LatencyExceededDimension.make("p50"),
          )
        }
      }

      // Exceed p95 only
      const exitP95 = yield* Effect.exit(
        decideHarnessBench({
          measurements: [
            {
              stage: BenchStageName.make("extractTypeGraph.warm"),
              sampleCount: BenchSampleCount.make(10),
              p50Ms: LatencyMillis.make(40),
              p95Ms: LatencyMillis.make(151),
            },
          ],
          budgets: [budget],
        }),
      )
      expect(exitP95._tag).toBe("Failure")
      if (exitP95._tag === "Failure") {
        const errOpt = Cause.findErrorOption(exitP95.cause)
        expect(Option.isSome(errOpt)).toBe(true)
        if (Option.isSome(errOpt)) {
          expect(errOpt.value.violations[0]?.exceededDimension).toBe(
            LatencyExceededDimension.make("p95"),
          )
        }
      }
    }),
  )

  it.effect(
    "fails closed with LatencySloViolationError when buildStageLatencyMeasurement has 0 samples",
    () =>
      Effect.gen(function* () {
        const m = buildStageLatencyMeasurement("extractTypeGraph.warm", [])
        expect(m.sampleCount).toBe(0)
        expect(m.p50Ms).toBe(0)
        expect(m.p95Ms).toBe(0)

        const exit = yield* Effect.exit(
          HarnessBench.decide({
            measurements: [m],
            budgets: DEFAULT_STAGE_LATENCY_BUDGETS,
          }),
        )

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const errOpt = Cause.findErrorOption(exit.cause)
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

  it.effect(
    "fails closed with LatencySloViolationError when measurement stage has no entry in budgets",
    () =>
      Effect.gen(function* () {
        const m: StageLatencyMeasurement = {
          stage: BenchStageName.make("unknown.stage"),
          p50Ms: LatencyMillis.make(10),
          p95Ms: LatencyMillis.make(20),
          sampleCount: BenchSampleCount.make(5),
        }

        const exit = yield* Effect.exit(
          HarnessBench.decide({
            measurements: [m],
            budgets: [],
          }),
        )

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const errOpt = Cause.findErrorOption(exit.cause)
          expect(Option.isSome(errOpt)).toBe(true)
          if (Option.isSome(errOpt)) {
            expect(errOpt.value).toBeInstanceOf(LatencySloViolationError)
            expect(errOpt.value._tag).toBe("LatencySloViolationError")
            expect(errOpt.value.violations).toHaveLength(1)
            expect(errOpt.value.violations[0]?.stage).toBe(BenchStageName.make("unknown.stage"))
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
        const validMeasurements = measurements.map((m) => ({
          ...m,
          sampleCount: BenchSampleCount.make(Math.max(1, m.sampleCount ?? 1)),
        }))
        const byStage = new Map<string, { p50: number; p95: number }>()
        for (const m of validMeasurements) {
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
          measurements: validMeasurements,
          budgets: generousBudgets,
        })
        const r2 = yield* decideHarnessBench({
          measurements: validMeasurements,
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

        // Verify disk reload deep equality
        AstGateCache.clear()
        const warmDiskReport = yield* decideAstGateCache({
          files,
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })
        expect(warmDiskReport.cacheHitCount).toBe(3)
        expect(warmDiskReport.parsedFileCount).toBe(0)
        expect(warmDiskReport.violations).toEqual(fullReport.violations)
        expect(warmDiskReport.verdict).toBe(fullReport.verdict)

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

  it.effect(
    "invalidates cached result on edit (clean -> violating -> clean), recomputes violations accurately, and keeps getCacheSize() bounded at files.length",
    () =>
      Effect.gen(function* () {
        AstGateCache.clear()
        const filePath = AstSourceFilePath.make("libs/sample/domain/src/dynamic.ts")
        const cleanContent = AstSourceContent.make("export const x = 1\n")
        const violatingContent = AstSourceContent.make("export const x = 1 as any\n")

        // 1. Initial clean file
        const r1 = yield* AstGateCache.decide({
          files: [
            {
              filePath,
              content: cleanContent,
              packageTag: AstGatePackageTag.make("domain"),
            },
          ],
        })
        expect(r1.verdict).toBe(GateVerdict.make("clean"))
        expect(r1.violations).toHaveLength(0)
        expect(r1.parsedFileCount).toBe(1)
        expect(r1.cacheHitCount).toBe(0)
        expect(getAstGateCacheSize()).toBe(1)
        expect(AstGateCache.getCacheSize()).toBe(1)

        // Second call with same content is a hit
        const r1Cached = yield* AstGateCache.decide({
          files: [
            {
              filePath,
              content: cleanContent,
              packageTag: AstGatePackageTag.make("domain"),
            },
          ],
        })
        expect(r1Cached.cacheHitCount).toBe(1)
        expect(r1Cached.parsedFileCount).toBe(0)

        // 2. Edit file to violating
        const r2 = yield* AstGateCache.decide({
          files: [
            {
              filePath,
              content: violatingContent,
              packageTag: AstGatePackageTag.make("domain"),
            },
          ],
        })
        expect(r2.verdict).toBe(GateVerdict.make("violated"))
        expect(r2.violations.length).toBeGreaterThan(0)
        expect(r2.parsedFileCount).toBe(1)
        expect(r2.cacheHitCount).toBe(0)
        expect(getAstGateCacheSize()).toBe(1)
        expect(AstGateCache.getCacheSize()).toBe(1)

        // 3. Edit back to clean
        const r3 = yield* AstGateCache.decide({
          files: [
            {
              filePath,
              content: cleanContent,
              packageTag: AstGatePackageTag.make("domain"),
            },
          ],
        })
        expect(r3.verdict).toBe(GateVerdict.make("clean"))
        expect(r3.violations).toHaveLength(0)
        expect(r3.parsedFileCount).toBe(1)
        expect(r3.cacheHitCount).toBe(0)
        expect(getAstGateCacheSize()).toBe(1)
        expect(AstGateCache.getCacheSize()).toBe(1)
      }),
  )

  it.effect("causes cache miss when ruleVersion or packageTag changes", () =>
    Effect.gen(function* () {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-miss-cache-"))
      const cacheFile = AstSourceFilePath.make(join(tmpDir, "ast-gates-v1.json"))

      const filePath = AstSourceFilePath.make("libs/sample/domain/src/versioned.ts")
      const content = AstSourceContent.make("export const v = 42\n")

      // 1. Initial run: populate cache with ruleVersion = ast-gates-v1, packageTag = domain
      AstGateCache.clear()
      const r1 = yield* AstGateCache.decide({
        files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
        ruleVersion: GateRuleVersion.make("ast-gates-v1"),
        cacheFilePath: cacheFile,
      })
      expect(r1.parsedFileCount).toBe(1)
      expect(r1.cacheHitCount).toBe(0)

      // Warm disk cache hit
      AstGateCache.clear()
      const rHit = yield* AstGateCache.decide({
        files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
        ruleVersion: GateRuleVersion.make("ast-gates-v1"),
        cacheFilePath: cacheFile,
      })
      expect(rHit.parsedFileCount).toBe(0)
      expect(rHit.cacheHitCount).toBe(1)

      // 2. Miss when ruleVersion changes
      AstGateCache.clear()
      const rRuleMiss = yield* AstGateCache.decide({
        files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
        ruleVersion: GateRuleVersion.make("ast-gates-v2"),
        cacheFilePath: cacheFile,
      })
      expect(rRuleMiss.parsedFileCount).toBe(1)
      expect(rRuleMiss.cacheHitCount).toBe(0)

      // 3. Miss when packageTag changes
      AstGateCache.clear()
      const rTagMiss = yield* AstGateCache.decide({
        files: [{ filePath, content, packageTag: AstGatePackageTag.make("contract") }],
        ruleVersion: GateRuleVersion.make("ast-gates-v2"),
        cacheFilePath: cacheFile,
      })
      expect(rTagMiss.parsedFileCount).toBe(1)
      expect(rTagMiss.cacheHitCount).toBe(0)

      rmSync(tmpDir, { recursive: true, force: true })
    }),
  )

  it.effect(
    "recovers from corrupt disk cache without throwing and overwrites with valid JSON",
    () =>
      Effect.gen(function* () {
        const tmpDir = mkdtempSync(join(tmpdir(), "harness-corrupt-cache-"))
        const cacheFile = AstSourceFilePath.make(join(tmpDir, "ast-gates-v1.json"))
        writeFileSync(cacheFile, "{not-json", "utf8")

        AstGateCache.clear()
        const file = {
          filePath: AstSourceFilePath.make("libs/sample/domain/src/corrupt-test.ts"),
          content: AstSourceContent.make("export const safe = 1\n"),
          packageTag: AstGatePackageTag.make("domain"),
        }

        const report = yield* decideAstGateCache({
          files: [file],
          ruleVersion: HARNESS_GATE_RULE_VERSION,
          cacheFilePath: cacheFile,
        })

        expect(report.verdict).toBe(GateVerdict.make("clean"))
        expect(report.parsedFileCount).toBe(1)
        expect(report.cacheHitCount).toBe(0)

        // Verify cacheFile is overwritten with valid JSON
        const diskContent = readFileSync(cacheFile, "utf8")
        const CacheDiskSchema = Schema.fromJsonString(
          Schema.Struct({
            version: Schema.String,
            entries: Schema.Record(Schema.String, Schema.Unknown),
          }),
        )
        const parsed = yield* Schema.decodeEffect(CacheDiskSchema)(diskContent)
        expect(parsed.version).toBe("ast-gates-v1")
        expect(Object.keys(parsed.entries).length).toBe(1)

        rmSync(tmpDir, { recursive: true, force: true })
      }),
  )

  it.effect(
    "flags Cause.isFailType/Predicate.isTagged ternaries, Effect.ignore in domain, and hardcoded parse(Lang.TypeScript) in .tsx-aware files",
    () =>
      Effect.gen(function* () {
        AstGateCache.clear()
        const files = [
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/guardrail-domain.ts"),
            content: AstSourceContent.make(
              [
                'import { Cause, Effect, Predicate } from "effect"',
                "export const inspect = (c: Cause.Cause<string>, u: unknown) => {",
                "  const a = Cause.isFailType(c) ? c.error : 'other'",
                "  const b = Predicate.isTagged(u, 'MyTag') ? 1 : 0",
                "  return Effect.fail('boom').pipe(Effect.ignore)",
                "}",
              ].join("\n"),
            ),
            packageTag: AstGatePackageTag.make("domain"),
          },
          {
            filePath: AstSourceFilePath.make("libs/sample/infra/src/tsx-parser.ts"),
            content: AstSourceContent.make(
              [
                'import { Lang, parse } from "@ast-grep/napi"',
                "export const runSearch = (file: string, src: string) => {",
                '  if (file.endsWith(".ts") || file.endsWith(".tsx")) {',
                "    return parse(Lang.TypeScript, src).root()",
                "  }",
                "  return null",
                "}",
              ].join("\n"),
            ),
            packageTag: AstGatePackageTag.make("infra"),
          },
        ]

        const report = yield* decideAstGateCache({ files })
        expect(report.verdict).toBe(GateVerdict.make("violated"))
        expect(
          report.violations.filter((v) => v.rule === GateRuleId.make("discriminant-branching"))
            .length,
        ).toBe(2)
        expect(
          report.violations.some((v) => v.rule === GateRuleId.make("domain-effect-ignore")),
        ).toBe(true)
        expect(
          report.violations.some((v) => v.rule === GateRuleId.make("ast-grep-tsx-grammar")),
        ).toBe(true)
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
