import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AstGateEvaluationReport,
  AstGateViolationContract,
  NonNegativeCount,
} from "@harness/contract"
import { AstGateCachePort } from "@harness/service"
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
  computeContentSha256,
  computePercentileMillis,
  ContentSha256,
  decideAstGateCache,
  decideDomainPurityGate,
  decideEffectLawsGate,
  decideHarnessBench,
  decideSyntaxBansGate,
  decideTestIntegrityGate,
  DEFAULT_STAGE_LATENCY_BUDGETS,
  evaluateAstGateFiles,
  evaluateCachedAstGates,
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
  inferPackageTagFromPath,
  LatencyExceededDimension,
  LatencyMillis,
  LatencySloViolationError,
  MigrationSafety,
  StageLatencyEvaluation,
  StageLatencyMeasurement,
  StageLatencyStatus,
  StageLatencyViolation,
} from "../src/index.js"

const CompositeStageMeasurementsArb = Schema.Array(StageLatencyMeasurement)

const CompositeAstGateFilesArb = Schema.Array(AstGateFileInput)

const makeInMemoryAstGateCachePortLayer = (): Layer.Layer<AstGateCachePort> =>
  Layer.effect(
    AstGateCachePort,
    Effect.sync(() => {
      const store = new Map<string, AstGateCacheEntry>()
      return {
        evaluateBatch: (files) =>
          Effect.sync(() => {
            const report = evaluateAstGateFiles(
              {
                files: files.map((f) => ({
                  filePath: f.filePath,
                  content: f.content,
                  ...(f.packageTag !== undefined ? { packageTag: f.packageTag } : {}),
                })),
              },
              undefined,
              store,
            )
            return {
              verdict: report.verdict,
              violations: report.violations.map((v) =>
                AstGateViolationContract.make({
                  category: v.category,
                  rule: v.rule,
                  message: v.message,
                  file: v.file,
                  line: v.line,
                  enclosingSymbol: v.enclosingSymbol,
                }),
              ),
              inspectedFileCount: NonNegativeCount.make(files.length),
              cacheHitCount: report.cacheHitCount,
            } satisfies AstGateEvaluationReport
          }),
        clearCache: Effect.sync(() => {
          store.clear()
        }),
        cacheSize: Effect.sync(() => NonNegativeCount.make(store.size)),
      }
    }),
  )

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

      match(exitBoth)
        .with({ _tag: "Success" }, () => {
          expect.fail("Expected LatencySloViolationError failure, got Success")
        })
        .with({ _tag: "Failure" }, ({ cause }) =>
          match(Cause.findErrorOption(cause))
            .with({ _tag: "None" }, () => {
              expect.fail("Expected typed LatencySloViolationError in Cause")
            })
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value).toBeInstanceOf(LatencySloViolationError)
              expect(value._tag).toBe("LatencySloViolationError")
              expect(value.violations).toHaveLength(1)
              expect(value.violations[0]?.exceededDimension).toBe(
                LatencyExceededDimension.make("both"),
              )
            })
            .exhaustive(),
        )
        .exhaustive()

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
      match(exitP50)
        .with({ _tag: "Success" }, () => {
          expect.fail("Expected LatencySloViolationError failure, got Success")
        })
        .with({ _tag: "Failure" }, ({ cause }) =>
          match(Cause.findErrorOption(cause))
            .with({ _tag: "None" }, () => {
              expect.fail("Expected typed LatencySloViolationError in Cause")
            })
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value.violations[0]?.exceededDimension).toBe(
                LatencyExceededDimension.make("p50"),
              )
            })
            .exhaustive(),
        )
        .exhaustive()

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
      match(exitP95)
        .with({ _tag: "Success" }, () => {
          expect.fail("Expected LatencySloViolationError failure, got Success")
        })
        .with({ _tag: "Failure" }, ({ cause }) =>
          match(Cause.findErrorOption(cause))
            .with({ _tag: "None" }, () => {
              expect.fail("Expected typed LatencySloViolationError in Cause")
            })
            .with({ _tag: "Some" }, ({ value }) => {
              expect(value.violations[0]?.exceededDimension).toBe(
                LatencyExceededDimension.make("p95"),
              )
            })
            .exhaustive(),
        )
        .exhaustive()
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

        match(exit)
          .with({ _tag: "Success" }, () => {
            expect.fail("Expected LatencySloViolationError failure, got Success")
          })
          .with({ _tag: "Failure" }, ({ cause }) =>
            match(Cause.findErrorOption(cause))
              .with({ _tag: "None" }, () => {
                expect.fail("Expected typed LatencySloViolationError in Cause")
              })
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(LatencySloViolationError)
                expect(value._tag).toBe("LatencySloViolationError")
                expect(value.violations).toHaveLength(1)
                expect(value.violations[0]?.exceededDimension).toBe(
                  LatencyExceededDimension.make("both"),
                )
              })
              .exhaustive(),
          )
          .exhaustive()
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

        match(exit)
          .with({ _tag: "Success" }, () => {
            expect.fail("Expected LatencySloViolationError failure, got Success")
          })
          .with({ _tag: "Failure" }, ({ cause }) =>
            match(Cause.findErrorOption(cause))
              .with({ _tag: "None" }, () => {
                expect.fail("Expected typed LatencySloViolationError in Cause")
              })
              .with({ _tag: "Some" }, ({ value }) => {
                expect(value).toBeInstanceOf(LatencySloViolationError)
                expect(value._tag).toBe("LatencySloViolationError")
                expect(value.violations).toHaveLength(1)
                expect(value.violations[0]?.stage).toBe(BenchStageName.make("unknown.stage"))
                expect(value.violations[0]?.exceededDimension).toBe(
                  LatencyExceededDimension.make("both"),
                )
              })
              .exhaustive(),
          )
          .exhaustive()
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
    "parses each modified SourceFile at most once across all 5 AST gate categories and hits local cacheStore",
    () =>
      Effect.gen(function* () {
        const cacheStore = new Map<string, AstGateCacheEntry>()

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

        const fullReport = yield* AstGateCache.decide(
          {
            files,
            ruleVersion: HARNESS_GATE_RULE_VERSION,
          },
          cacheStore,
        )

        expect(fullReport.verdict).toBe(GateVerdict.make("violated"))
        expect(fullReport.parsedFileCount).toBe(3)
        expect(fullReport.cacheHitCount).toBe(0)
        expect(cacheStore.size).toBe(3)

        // Subsequent category-specific gate calls reuse the cached violations with 0 new parses
        const syntaxReport = evaluateAstGateFiles(
          { files, ruleVersion: HARNESS_GATE_RULE_VERSION },
          GateCategory.make("syntax-bans"),
          cacheStore,
        )
        const testReport = evaluateAstGateFiles(
          { files, ruleVersion: HARNESS_GATE_RULE_VERSION },
          GateCategory.make("test-integrity"),
          cacheStore,
        )
        const purityReport = evaluateAstGateFiles(
          { files, ruleVersion: HARNESS_GATE_RULE_VERSION },
          GateCategory.make("domain-purity"),
          cacheStore,
        )
        const effectLawsReport = evaluateAstGateFiles(
          { files, ruleVersion: HARNESS_GATE_RULE_VERSION },
          GateCategory.make("effect-laws"),
          cacheStore,
        )
        const migSafetyReport = yield* MigrationSafety.decide({
          files: [{ file: "libs/sample/infra/src/bad-infra.ts", sql: "DROP TABLE users" }],
        })

        expect(syntaxReport.cacheHitCount).toBe(3)
        expect(syntaxReport.parsedFileCount).toBe(0)
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
        expect(computeContentSha256("abc")).toHaveLength(64)
        expect(inferPackageTagFromPath("libs/sample/domain/src/a.ts")).toBe("domain")
      }),
  )

  it.effect(
    "invalidates cached result on edit (clean -> violating -> clean), recomputes violations accurately, and keeps cacheStore bounded at files.length",
    () =>
      Effect.gen(function* () {
        const cacheStore = new Map<string, AstGateCacheEntry>()
        const filePath = AstSourceFilePath.make("libs/sample/domain/src/dynamic.ts")
        const cleanContent = AstSourceContent.make("export const x = 1\n")
        const violatingContent = AstSourceContent.make("export const x = 1 as any\n")

        // 1. Initial clean file
        const r1 = yield* AstGateCache.decide(
          {
            files: [
              {
                filePath,
                content: cleanContent,
                packageTag: AstGatePackageTag.make("domain"),
              },
            ],
          },
          cacheStore,
        )
        expect(r1.verdict).toBe(GateVerdict.make("clean"))
        expect(r1.violations).toHaveLength(0)
        expect(r1.parsedFileCount).toBe(1)
        expect(r1.cacheHitCount).toBe(0)
        expect(cacheStore.size).toBe(1)

        // Second call with same content is a hit
        const r1Cached = yield* AstGateCache.decide(
          {
            files: [
              {
                filePath,
                content: cleanContent,
                packageTag: AstGatePackageTag.make("domain"),
              },
            ],
          },
          cacheStore,
        )
        expect(r1Cached.cacheHitCount).toBe(1)
        expect(r1Cached.parsedFileCount).toBe(0)

        // 2. Edit file to violating
        const r2 = yield* AstGateCache.decide(
          {
            files: [
              {
                filePath,
                content: violatingContent,
                packageTag: AstGatePackageTag.make("domain"),
              },
            ],
          },
          cacheStore,
        )
        expect(r2.verdict).toBe(GateVerdict.make("violated"))
        expect(r2.violations.length).toBeGreaterThan(0)
        expect(r2.parsedFileCount).toBe(1)
        expect(r2.cacheHitCount).toBe(0)
        expect(cacheStore.size).toBe(1)

        // 3. Edit back to clean
        const r3 = yield* AstGateCache.decide(
          {
            files: [
              {
                filePath,
                content: cleanContent,
                packageTag: AstGatePackageTag.make("domain"),
              },
            ],
          },
          cacheStore,
        )
        expect(r3.verdict).toBe(GateVerdict.make("clean"))
        expect(r3.violations).toHaveLength(0)
        expect(r3.parsedFileCount).toBe(1)
        expect(r3.cacheHitCount).toBe(0)
        expect(cacheStore.size).toBe(1)
      }),
  )

  it.effect("causes cache miss when ruleVersion or packageTag changes", () =>
    Effect.gen(function* () {
      const cacheStore = new Map<string, AstGateCacheEntry>()
      const filePath = AstSourceFilePath.make("libs/sample/domain/src/versioned.ts")
      const content = AstSourceContent.make("export const v = 42\n")

      // 1. Initial run: populate cache with ruleVersion = ast-gates-v1, packageTag = domain
      const r1 = yield* AstGateCache.decide(
        {
          files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
          ruleVersion: GateRuleVersion.make("ast-gates-v1"),
        },
        cacheStore,
      )
      expect(r1.parsedFileCount).toBe(1)
      expect(r1.cacheHitCount).toBe(0)

      // Warm cache hit
      const rHit = yield* AstGateCache.decide(
        {
          files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
          ruleVersion: GateRuleVersion.make("ast-gates-v1"),
        },
        cacheStore,
      )
      expect(rHit.parsedFileCount).toBe(0)
      expect(rHit.cacheHitCount).toBe(1)

      // 2. Miss when ruleVersion changes
      const rRuleMiss = yield* AstGateCache.decide(
        {
          files: [{ filePath, content, packageTag: AstGatePackageTag.make("domain") }],
          ruleVersion: GateRuleVersion.make("ast-gates-v2"),
        },
        cacheStore,
      )
      expect(rRuleMiss.parsedFileCount).toBe(1)
      expect(rRuleMiss.cacheHitCount).toBe(0)

      // 3. Miss when packageTag changes
      const rTagMiss = yield* AstGateCache.decide(
        {
          files: [{ filePath, content, packageTag: AstGatePackageTag.make("contract") }],
          ruleVersion: GateRuleVersion.make("ast-gates-v2"),
        },
        cacheStore,
      )
      expect(rTagMiss.parsedFileCount).toBe(1)
      expect(rTagMiss.cacheHitCount).toBe(0)
    }),
  )

  it.effect(
    "flags Cause.isFailType/Predicate.isTagged ternaries, Effect.ignore in domain, and hardcoded parse(Lang.TypeScript) in .tsx-aware files",
    () =>
      Effect.gen(function* () {
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

  it.effect(
    "REQ-3.1: AstGateCache.evaluateCached delegates to AstGateCachePort and increments cacheHitCount",
    () =>
      Effect.gen(function* () {
        const files = [
          {
            filePath: AstSourceFilePath.make("libs/sample/domain/src/cached-port.ts"),
            content: AstSourceContent.make("export const ok = 1\n"),
            packageTag: AstGatePackageTag.make("domain"),
          },
        ]

        const first = yield* evaluateCachedAstGates(files)
        expect(first.verdict).toBe("clean")
        expect(first.inspectedFileCount).toBe(1)
        expect(first.cacheHitCount).toBe(0)

        const second = yield* AstGateCache.evaluateCached(files)
        expect(second.verdict).toBe("clean")
        expect(second.inspectedFileCount).toBe(1)
        expect(second.cacheHitCount).toBe(1)
      }).pipe(Effect.provide(makeInMemoryAstGateCachePortLayer())),
  )

  it.effect.prop(
    "property: AstGateCache, SyntaxBans, TestIntegrity, DomainPurity, and EffectLaws deciders are idempotent and pure",
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
      }),
  )
})
