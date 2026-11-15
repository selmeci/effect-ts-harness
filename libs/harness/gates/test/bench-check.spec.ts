import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AstGateEvaluationReport,
  AstGatePackageTag,
  AstGateViolationContract,
  AstSourceContent,
  AstSourceFilePath,
  ContentSha256,
  GateCategory,
  GateRuleId,
  GateRuleVersion,
  GateVerdict,
  HARNESS_GATE_RULE_VERSION,
  makeAstGateEvaluationReport,
  NonNegativeCount,
} from "@harness/contract"
import { AstGateCachePort } from "@harness/service"
import {
  AstGateCache,
  AstGateCacheEntry,
  AstGateDecisionReport,
  BenchSampleCount,
  BenchStageName,
  buildStageLatencyMeasurement,
  computeContentSha256,
  computePercentileMillis,
  decideAstGateCache,
  decideDomainPurityGate,
  decideEffectLawsGate,
  decideHarnessBench,
  decideSyntaxBansGate,
  decideTestIntegrityGate,
  DEFAULT_STAGE_LATENCY_BUDGETS,
  evaluateAstGateFiles,
  evaluateCachedAstGates,
  HarnessBench,
  HarnessBenchReport,
  inferPackageTagFromPath,
  LatencyExceededDimension,
  LatencyMillis,
  LatencySloViolationError,
  MigrationSafety,
  StageLatencyMeasurement,
  StageLatencyStatus,
} from "../src/index.js"

const CompositeStageMeasurementsArb = Schema.Array(StageLatencyMeasurement)

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
            return makeAstGateEvaluationReport({
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
            }) satisfies AstGateEvaluationReport
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
      expect(Schema.is(BenchSampleCount)(4)).toBe(true)
      expect(Schema.is(BenchSampleCount)(-1)).toBe(false)
      expect(Schema.is(BenchStageName)("GraphRewrite.decide")).toBe(true)
      expect(Schema.is(BenchStageName)("")).toBe(false)
      expect(Schema.is(LatencyMillis)(-1)).toBe(false)
      expect(Exit.isSuccess(Schema.decodeExit(HarnessBenchReport)(report))).toBe(true)
      expect(Schema.is(HarnessBenchReport)({ status: "invalid" })).toBe(false)
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
        expect(migSafetyReport.violations).toEqual([
          expect.objectContaining({
            kind: "drop-statement",
            file: "libs/sample/infra/src/bad-infra.ts",
            statement: "DROP TABLE users",
          }),
        ])

        // Verify schema codecs (valid & invalid)
        const validSha = computeContentSha256("abc")
        expect(validSha).toHaveLength(64)
        expect(Exit.isSuccess(Schema.decodeExit(ContentSha256)(validSha))).toBe(true)
        expect(Schema.is(ContentSha256)("abc")).toBe(false)
        expect(Exit.isSuccess(Schema.decodeExit(GateRuleVersion)("ast-gates-v7"))).toBe(true)
        expect(Schema.is(GateRuleVersion)("")).toBe(false)
        expect(
          Exit.isSuccess(
            Schema.decodeExit(AstGateCacheEntry)({
              filePath: "libs/sample/domain/src/a.ts",
              contentSha256: validSha,
              ruleVersion: "ast-gates-v7",
              packageTag: "domain",
              violations: [],
            }),
          ),
        ).toBe(true)
        expect(
          Schema.is(AstGateCacheEntry)({
            filePath: "libs/sample/domain/src/a.ts",
            contentSha256: "short",
            ruleVersion: "ast-gates-v7",
            violations: [],
          }),
        ).toBe(false)
        expect(Exit.isSuccess(Schema.decodeExit(AstGateDecisionReport)(syntaxReport))).toBe(true)
        expect(Schema.is(AstGateDecisionReport)({ verdict: "unknown" })).toBe(false)
        expect(evaluateAstGateFiles({ files: [] }).verdict).toBe("clean")
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
        expect(r2.violations).toEqual([
          expect.objectContaining({
            rule: GateRuleId.make("unsafe-type-cast"),
            file: filePath,
            line: 1,
          }),
        ])
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
    "property: AstGateCache, SyntaxBans, TestIntegrity, DomainPurity, and EffectLaws deciders are deterministic across diverse ASTs",
    [
      Schema.Array(Schema.Literals(["clean", "unsafe-type-cast", "switch", "dummy-void"])).pipe(
        Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4)),
      ),
    ],
    ([kinds]) =>
      Effect.gen(function* () {
        const snippetMap = {
          clean: { code: "export const cleanVal = 42\n", expectedCount: 0 },
          "unsafe-type-cast": { code: "export const badCast = (1 as any)\n", expectedCount: 1 },
          switch: {
            code: "export const sw = (x: number) => { switch (x) { default: return 1 } }\n",
            expectedCount: 1,
          },
          "dummy-void": {
            code: 'import { Effect } from "effect"\nexport const fn = Effect.gen(function* () { yield* Effect.void; return 1 })\n',
            expectedCount: 1,
          },
        } as const
        const files = kinds.map((k, idx) => ({
          filePath: AstSourceFilePath.make(`libs/sample/domain/src/prop_${idx}.ts`),
          content: AstSourceContent.make(snippetMap[k].code),
          packageTag: AstGatePackageTag.make("domain"),
        }))
        const expectedCount = kinds.reduce((acc, k) => acc + snippetMap[k].expectedCount, 0)
        const r1 = yield* decideAstGateCache({ files })
        const r2 = yield* decideAstGateCache({ files })
        expect(r1.violations).toHaveLength(expectedCount)
        expect(r1.verdict).toBe(expectedCount === 0 ? "clean" : "violated")
        expect(r2.violations).toEqual(r1.violations)
        expect(r2.verdict).toBe(r1.verdict)

        const syntaxReport = yield* decideSyntaxBansGate({ files })
        const testReport = yield* decideTestIntegrityGate({ files })
        const purityReport = yield* decideDomainPurityGate({ files })
        const lawsReport = yield* decideEffectLawsGate({ files })
        expect(
          syntaxReport.violations.length +
            testReport.violations.length +
            purityReport.violations.length +
            lawsReport.violations.length,
        ).toBe(expectedCount)
      }),
  )
})
