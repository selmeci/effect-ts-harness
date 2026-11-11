import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import {
  ChaosFaultController,
  DstEngineConfig,
  DstErrorTag,
  DstExecutionTier,
  DstMethodName,
  DstProbabilityMillis,
  DstSeed,
  DstServiceTag,
  DstStepCount,
  DstTickMillis,
  decideDstSchedule,
  makeXorShift64Star,
  resolveDstSeedsForTier,
  runWithDecoupledClockDriver,
  withDeterministicFaults,
} from "../src/dst-engine.js"
import {
  EarsClauseId,
  EarsClausePatternKind,
  EarsClausePolarity,
  EarsConsistencyFlag,
  EarsConsistencyInput,
  EarsEffectSymbolName,
  EarsFilePath,
  EarsGuardPairRelation,
  EarsGuardText,
  EarsOutcomeTag,
  EarsSpecId,
  EarsVariantTag,
  decideEarsConsistency,
  evaluateEarsConsistencyReport,
} from "../src/ears-consistency.js"
import {
  PlanSearchCandidateId,
  PlanSearchCount,
  PlanSearchFlag,
  PlanSearchInput,
  PlanSearchScoreMillis,
  PlanSearchSummary,
  PlanSearchWorktreeId,
  decideLoopThrashing,
  decidePlanSearch,
} from "../src/friction-log.js"
import {
  compileMutantSchemaModule,
  decideMutationReport,
  discoverDomainMutants,
  evaluateMutantSchemaInProcess,
  evaluateSpanSaturationViolations,
  parseGitDiffModifiedLines,
} from "../src/mutation-check.js"
import {
  RuleGraphToken,
  RuleQualityScoreMillis,
  RuleSynthesisFlag,
  RuleSynthesisTaskId,
  RuleSynthesizerInput,
  RuleTargetPath,
  decideRuleSynthesizer,
  isImmutableTcbPath,
} from "../src/rule-synthesizer.js"
import {
  ForbiddenUnderCausalityRule,
  MustPrecedeCausalityRule,
  RequireCompensationOnFailureRule,
  SpanNameString,
  decideSpanBudgets,
} from "../src/span-budget.js"

class SimulatedTransientError extends Schema.TaggedError<SimulatedTransientError>()(
  "SimulatedTransientError",
  {
    serviceTag: Schema.String,
    methodName: Schema.String,
  },
) {}

interface SimulatedRepoShape {
  readonly saveWithRetry: (orderId: string) => Effect.Effect<string, SimulatedTransientError>
}

class SimulatedRepo extends Context.Service<SimulatedRepo, SimulatedRepoShape>()("SimulatedRepo") {}

describe("Milestone 5: EARS Consistency, DST Engine, Span Causality, Mutant Schemata & DPO Rule Synthesis", () => {
  describe("Step 1: EarsConsistency.decide (EARS-01, EARS-02, EARS-03)", () => {
    it.effect.prop(
      "passes when clauses cover all state variants without contradictory or shadowed guards",
      [
        Schema.Struct({
          okOut: EarsOutcomeTag,
          errOut: EarsOutcomeTag,
        }),
      ],
      ([sample]) =>
        Effect.gen(function* () {
          const input: EarsConsistencyInput = {
            specId: EarsSpecId.make("harness:SPEC-0009"),
            filePath: EarsFilePath.make("libs/harness/docs/specs/sample.md"),
            stateDomainVariants: [EarsVariantTag.make("Open"), EarsVariantTag.make("Closed")],
            guardDomainVariants: [EarsVariantTag.make("ValidCart")],
            clauses: [
              {
                clauseId: EarsClauseId.make("SPEC-1.1"),
                pattern: EarsClausePatternKind.make("State-driven"),
                effectSymbol: EarsEffectSymbolName.make("Cart.decide"),
                activeStateVariant: EarsVariantTag.make("Open"),
                guardVariant: EarsVariantTag.make("ValidCart"),
                outcomeTag: sample.okOut,
                polarity: EarsClausePolarity.make("shall"),
              },
              {
                clauseId: EarsClauseId.make("SPEC-1.2"),
                pattern: EarsClausePatternKind.make("State-driven"),
                effectSymbol: EarsEffectSymbolName.make("Cart.decide"),
                activeStateVariant: EarsVariantTag.make("Closed"),
                guardVariant: EarsVariantTag.make("ValidCart"),
                outcomeTag: sample.errOut,
                polarity: EarsClausePolarity.make("shall"),
              },
            ],
            requireExhaustiveStateCoverage: EarsConsistencyFlag.make(true),
          }
          const report = yield* decideEarsConsistency(input)
          expect(report.ok).toBe(true)
          expect(report.violations).toHaveLength(0)
        }),
    )

    it.effect.prop(
      "detects EARS-01 contradictory clauses, EARS-02 shadowed clauses, and EARS-03 incomplete state coverage and fails with EarsConsistencyError",
      [
        Schema.Struct({
          specId: EarsSpecId,
        }),
      ],
      ([{ specId }]) =>
        Effect.gen(function* () {
          const input: EarsConsistencyInput = {
            specId,
            filePath: EarsFilePath.make("libs/harness/docs/specs/sample.md"),
            stateDomainVariants: [
              EarsVariantTag.make("Available"),
              EarsVariantTag.make("Depleted"),
              EarsVariantTag.make("Discontinued"),
            ],
            guardDomainVariants: [
              EarsVariantTag.make("InStock"),
              EarsVariantTag.make("StrictInStock"),
            ],
            clauses: [
              {
                clauseId: EarsClauseId.make("SPEC-2.1"),
                pattern: EarsClausePatternKind.make("Complex"),
                effectSymbol: EarsEffectSymbolName.make("Inventory.decide"),
                activeStateVariant: EarsVariantTag.make("Available"),
                guardVariant: EarsVariantTag.make("InStock"),
                guardText: EarsGuardText.make("quantity <= available"),
                outcomeTag: EarsOutcomeTag.make("StockReserved"),
                polarity: EarsClausePolarity.make("shall"),
              },
              {
                clauseId: EarsClauseId.make("SPEC-2.2"),
                pattern: EarsClausePatternKind.make("Complex"),
                effectSymbol: EarsEffectSymbolName.make("Inventory.decide"),
                activeStateVariant: EarsVariantTag.make("Available"),
                guardVariant: EarsVariantTag.make("InStock"),
                guardText: EarsGuardText.make("quantity <= available"),
                outcomeTag: EarsOutcomeTag.make("OutOfStockError"),
                polarity: EarsClausePolarity.make("shall"),
              },
              {
                clauseId: EarsClauseId.make("SPEC-2.3"),
                pattern: EarsClausePatternKind.make("Complex"),
                effectSymbol: EarsEffectSymbolName.make("Inventory.decide"),
                activeStateVariant: EarsVariantTag.make("Available"),
                guardVariant: EarsVariantTag.make("StrictInStock"),
                guardText: EarsGuardText.make("quantity < available"),
                outcomeTag: EarsOutcomeTag.make("StockReserved"),
                polarity: EarsClausePolarity.make("shall"),
              },
            ],
            guardPairPriors: [
              {
                firstClauseId: EarsClauseId.make("SPEC-2.1"),
                secondClauseId: EarsClauseId.make("SPEC-2.3"),
                relation: EarsGuardPairRelation.make("first_subsumes_second"),
              },
            ],
            requireExhaustiveStateCoverage: EarsConsistencyFlag.make(true),
          }

          const report = evaluateEarsConsistencyReport(input)
          expect(report.ok).toBe(false)
          expect(report.violations.map((v) => v.ruleId)).toEqual(["EARS-01", "EARS-02", "EARS-03"])

          const error = yield* Effect.flip(decideEarsConsistency(input))
          expect(error._tag).toBe("EarsConsistencyError")
          expect(error.specId).toBe(specId)
          expect(error.violations.map((v) => v.ruleId)).toEqual(["EARS-01", "EARS-02", "EARS-03"])
        }),
    )
  })

  describe("Step 2: DstEngine.decide, runWithDecoupledClockDriver & LISA SpanBudget.decide", () => {
    it.effect.prop(
      "deterministically generates identical fault schedules from the same DstSeed and fails with DstScheduleError when targets are empty",
      [
        Schema.Struct({
          seed: DstSeed,
          stepCount: DstStepCount.pipe(
            Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
          ),
        }),
      ],
      ([{ seed, stepCount }]) =>
        Effect.gen(function* () {
          const config: DstEngineConfig = {
            seed,
            stepCount,
            targets: [
              {
                serviceTag: DstServiceTag.make("OrderRepo"),
                methodName: DstMethodName.make("save"),
                declaredErrors: [DstErrorTag.make("SqlTransientError")],
              },
              {
                serviceTag: DstServiceTag.make("OutboxRelay"),
                methodName: DstMethodName.make("publish"),
                declaredErrors: [DstErrorTag.make("NetworkTimeoutError")],
              },
            ],
            baseFailureProbMillis: DstProbabilityMillis.make(700),
            baseDelayProbMillis: DstProbabilityMillis.make(150),
            baseInterruptProbMillis: DstProbabilityMillis.make(50),
            maxDelayTicksMs: DstTickMillis.make(25),
            hazardPriors: {
              "OrderRepo.save": DstProbabilityMillis.make(900),
            },
          }

          const first = yield* decideDstSchedule(config)
          const second = yield* decideDstSchedule(config)
          expect(first).toEqual(second)
          expect(first.steps).toHaveLength(stepCount)

          const emptyTargetsErr = yield* Effect.flip(
            decideDstSchedule({
              ...config,
              targets: [],
            }),
          )
          expect(emptyTargetsErr._tag).toBe("DstScheduleError")
          expect(emptyTargetsErr.seed).toBe(seed)
        }),
    )

    it.effect(
      "advances virtual time via decoupled supervisor clockDriver fiber without TestClock deadlock",
      () =>
        Effect.gen(function* () {
          const prngA = makeXorShift64Star(DstSeed.make(42))
          const prngB = makeXorShift64Star(DstSeed.make(42))
          expect(prngA.nextUint64()).toBe(prngB.nextUint64())
          expect(resolveDstSeedsForTier(DstExecutionTier.make("fast"))).toHaveLength(10)
          expect(resolveDstSeedsForTier(DstExecutionTier.make("full"))).toHaveLength(100)

          const config: DstEngineConfig = {
            seed: DstSeed.make(7),
            stepCount: DstStepCount.make(2),
            targets: [
              {
                serviceTag: DstServiceTag.make("SimulatedRepo"),
                methodName: DstMethodName.make("saveWithRetry"),
                declaredErrors: [DstErrorTag.make("SimulatedTransientError")],
              },
            ],
            baseFailureProbMillis: DstProbabilityMillis.make(1000),
            baseDelayProbMillis: DstProbabilityMillis.make(0),
            baseInterruptProbMillis: DstProbabilityMillis.make(0),
            maxDelayTicksMs: DstTickMillis.make(20),
          }

          let attempts = 0
          const program = Effect.gen(function* () {
            const controller = yield* ChaosFaultController
            const repo = yield* SimulatedRepo
            const decision = yield* controller.nextStepFor(
              DstServiceTag.make("SimulatedRepo"),
              DstMethodName.make("saveWithRetry"),
            )
            expect(decision._tag).toBe("FailWithError")
            return yield* repo.saveWithRetry("order-1")
          }).pipe(
            Effect.provideService(SimulatedRepo, {
              saveWithRetry: (orderId: string) =>
                Effect.gen(function* () {
                  attempts++
                  yield* Effect.sleep("40 millis")
                  if (attempts === 1) {
                    return yield* new SimulatedTransientError({
                      serviceTag: "SimulatedRepo",
                      methodName: `saveWithRetry:${orderId}`,
                    })
                  }
                  return "saved-after-virtual-sleep"
                }).pipe(
                  Effect.catchTag("SimulatedTransientError", () =>
                    Effect.sleep("20 millis").pipe(Effect.as("recovered-on-retry")),
                  ),
                ),
            }),
          )

          const result = yield* withDeterministicFaults(program, config, DstTickMillis.make(20))
          expect(result).toBe("recovered-on-retry")
          expect(attempts).toBe(1)

          const directSleep = yield* runWithDecoupledClockDriver(
            Effect.sleep("50 millis").pipe(Effect.as("done")),
            {
              seed: DstSeed.make(1),
              tickMs: DstTickMillis.make(25),
              maxTicks: DstStepCount.make(16),
            },
          )
          expect(directSleep).toBe("done")
        }),
    )

    it.effect.prop(
      "enforces LISA temporal causality rules (MustPrecede CAUS-01, ForbiddenUnder CAUS-02, RequireCompensationOnFailure CAUS-01) and fails with SpanCausalityError when failOnViolation is true",
      [
        Schema.Struct({
          budgetMs: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 50, maximum: 500 }))),
        }),
      ],
      ([{ budgetMs }]) =>
        Effect.gen(function* () {
          const causalityRules = [
            MustPrecedeCausalityRule.make({
              prerequisiteSpan: SpanNameString.make("Repo.append"),
              dependentSpan: SpanNameString.make("Outbox.enqueue"),
            }),
            ForbiddenUnderCausalityRule.make({
              ancestorSpan: SpanNameString.make("Cart.decide"),
              forbiddenDescendantSpan: SpanNameString.make("D1.execute"),
            }),
            RequireCompensationOnFailureRule.make({
              failedSpan: SpanNameString.make("Payment.charge"),
              compensationSpan: SpanNameString.make("Inventory.release"),
            }),
          ]

          const validViolations = yield* decideSpanBudgets({
            maxSpanDurationMs: budgetMs,
            causalityRules,
            spans: [
              {
                spanId: "s1",
                parentSpanId: null,
                name: "Repo.append",
                durationMs: 10,
                startTimeMs: 1,
                endTimeMs: 2,
                exitTag: "Success",
              },
              {
                spanId: "s2",
                parentSpanId: null,
                name: "Outbox.enqueue",
                durationMs: 10,
                startTimeMs: 3,
                endTimeMs: 4,
                exitTag: "Success",
              },
              {
                spanId: "s3",
                parentSpanId: null,
                name: "Payment.charge",
                durationMs: 10,
                startTimeMs: 5,
                endTimeMs: 6,
                exitTag: "Failure",
              },
              {
                spanId: "s4",
                parentSpanId: null,
                name: "Inventory.release",
                durationMs: 10,
                startTimeMs: 7,
                endTimeMs: 8,
                exitTag: "Success",
              },
            ],
          })

          expect(validViolations).toEqual([])

          const invalidSpans = [
            {
              spanId: "s1",
              parentSpanId: null,
              name: "Outbox.enqueue",
              startTimeMs: 1,
              endTimeMs: 2,
              exitTag: "Success" as const,
            },
            {
              spanId: "s2",
              parentSpanId: null,
              name: "Cart.decide",
              startTimeMs: 3,
              endTimeMs: 10,
              exitTag: "Success" as const,
            },
            {
              spanId: "s3",
              parentSpanId: "s2",
              name: "D1.execute",
              startTimeMs: 4,
              endTimeMs: 5,
              exitTag: "Success" as const,
            },
            {
              spanId: "s4",
              parentSpanId: null,
              name: "Payment.charge",
              startTimeMs: 11,
              endTimeMs: 12,
              exitTag: "Failure" as const,
            },
          ]

          const violated = yield* decideSpanBudgets({
            causalityRules,
            spans: invalidSpans,
          })

          expect(violated.map((v) => v.ruleId)).toEqual(["CAUS-01", "CAUS-02", "CAUS-01"])

          const causalityErr = yield* Effect.flip(
            decideSpanBudgets({
              causalityRules,
              failOnViolation: true,
              spans: invalidSpans,
            }),
          )
          expect(causalityErr._tag).toBe("SpanCausalityError")
          expect(causalityErr.violations.map((v) => v.ruleId)).toEqual([
            "CAUS-01",
            "CAUS-02",
            "CAUS-01",
          ])
        }),
    )
  })

  describe("Step 3: Zero-Respawn Mutant Schemata, SAT-01, SAT-02 & MutantEquivalenceV1", () => {
    it.effect.prop(
      "evaluates Mutant Schemata in-process in < 200ms and filters equivalent mutants >= 850 millis",
      [
        Schema.Struct({
          equivScore: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 850, maximum: 1000 })),
          ),
        }),
      ],
      ([{ equivScore }]) =>
        Effect.gen(function* () {
          const diffText = [
            "--- a/libs/sample/domain/src/cart.ts",
            "+++ b/libs/sample/domain/src/cart.ts",
            "@@ -2,1 +2,2 @@",
            "+  if (qty >= 10) return true",
          ].join("\n")
          const diffMap = parseGitDiffModifiedLines(diffText)
          expect(diffMap.get("libs/sample/domain/src/cart.ts")?.has(2)).toBe(true)

          const source = [
            "export const checkQty = (qty: number): boolean => {",
            "  if (qty >= 10) return true",
            "  return false",
            "}",
          ].join("\n")

          const scopedMutants = discoverDomainMutants("libs/sample/domain/src/cart.ts", source, {
            modifiedLines: diffMap.get("libs/sample/domain/src/cart.ts"),
          })
          expect(scopedMutants.length).toBeGreaterThan(0)
          expect(scopedMutants.every((m) => m.line === 2)).toBe(true)

          const schemaBundle = compileMutantSchemaModule(
            "libs/sample/domain/src/cart.ts",
            source,
            scopedMutants,
          )
          expect(schemaBundle.schemaSource).toContain("globalThis.__HARNESS_ACTIVE_MUTANT_ID")

          const startMs = performance.now()
          const inProcessOutcomes = evaluateMutantSchemaInProcess(scopedMutants, [
            (activeId) => !schemaBundle.schemaSource.includes(activeId),
          ])
          const elapsedMs = performance.now() - startMs
          expect(elapsedMs).toBeLessThan(200)
          expect(inProcessOutcomes.every((o) => o.status === "killed")).toBe(true)

          const survivedMutant = scopedMutants[0]!
          const reportWithEquiv = yield* decideMutationReport({
            outcomes: [{ mutant: survivedMutant, status: "survived" }],
            equivalencePriors: { [survivedMutant.id]: equivScore },
          })
          expect(reportWithEquiv.passed).toBe(true)
          expect(reportWithEquiv.equivalentCount).toBe(1)
        }),
    )

    it.effect(
      "enforces SAT-01 (descendant-aware error saturation) and SAT-02 (branch saturation)",
      () =>
        Effect.gen(function* () {
          yield* Effect.void
          const specs = [
            {
              spanQualname: "libs/sample/domain/src/cart.ts#checkout",
              spanName: "Cart.checkout",
              filePath: "libs/sample/domain/src/cart.ts",
              declaredErrorTags: ["EmptyCartError", "PaymentDeclinedError"],
              declaredBranchTags: ["OrderPlaced", "OrderBackordered"],
            },
          ]

          const observations = [
            {
              spanId: "root-checkout",
              parentSpanId: null,
              name: "Cart.checkout",
              exitTag: "Success" as const,
              valueTag: "OrderPlaced",
            },
            {
              spanId: "child-validate",
              parentSpanId: "root-checkout",
              name: "Cart.validate",
              exitTag: "Failure" as const,
              errorTag: "EmptyCartError",
            },
          ]

          const violations = evaluateSpanSaturationViolations(specs, observations)
          expect(violations).toHaveLength(2)
          expect(violations[0]?.ruleId).toBe("SAT-01")
          expect(violations[0]?.missingTags).toEqual(["PaymentDeclinedError"])
          expect(violations[1]?.ruleId).toBe("SAT-02")
          expect(violations[1]?.missingTags).toEqual(["OrderBackordered"])
        }),
    )
  })

  describe("Step 4: RuleSynthesizer.decide (LGG Anti-Unification & 4-Stage Cascade) & PlanSearch.decide", () => {
    it.effect.prop(
      "synthesizes DPO rewrite rules via LGG anti-unification (?Scope) and enforces the 4-stage AlphaEvolve cascade",
      [
        Schema.Struct({
          taskId: RuleSynthesisTaskId,
          qualityScore: RuleQualityScoreMillis.pipe(
            Schema.check(Schema.isBetween({ minimum: 750, maximum: 990 })),
          ),
        }),
      ],
      ([{ taskId, qualityScore }]) =>
        Effect.gen(function* () {
          expect(isImmutableTcbPath("libs/harness/gates/src/policy.ts")).toBe(true)
          expect(isImmutableTcbPath("libs//harness/gates/src/./policy.ts")).toBe(true)
          expect(isImmutableTcbPath("libs/cart/../../libs/harness/gates/src/policy.ts")).toBe(true)
          expect(isImmutableTcbPath("libs/cart/domain/src/cart.ts")).toBe(false)

          const input: RuleSynthesizerInput = {
            taskId,
            badGraphNodes: [
              RuleGraphToken.make("EffectFn:libs/cart/domain/src/checkout.ts#checkout"),
            ],
            badGraphHyperedges: [
              RuleGraphToken.make(
                "EffectSignature:libs/cart/domain/src/checkout.ts#checkout->requires-service->CartRepo",
              ),
            ],
            goodGraphNodes: [
              RuleGraphToken.make("EffectFn:libs/cart/domain/src/checkout.ts#checkout"),
              RuleGraphToken.make("TaggedError:libs/cart/contract/src/errors.ts#CartEmptyError"),
            ],
            goodGraphHyperedges: [
              RuleGraphToken.make(
                "EffectSignature:libs/cart/domain/src/checkout.ts#checkout->requires-service->CartRepo",
              ),
              RuleGraphToken.make(
                "EffectSignature:libs/cart/domain/src/checkout.ts#checkout->fails-with->CartEmptyError",
              ),
            ],
            healthyCorpusSnapshots: [
              {
                snapshotId: RuleSynthesisTaskId.make("healthy-sample"),
                isHealthy: RuleSynthesisFlag.make(true),
                nodeKeys: [
                  RuleGraphToken.make("EffectFn:libs/sample/domain/src/checkout.ts#checkout"),
                  RuleGraphToken.make(
                    "TaggedError:libs/sample/contract/src/errors.ts#CartEmptyError",
                  ),
                ],
                hyperedgeSignatures: [
                  RuleGraphToken.make(
                    "EffectSignature:libs/sample/domain/src/checkout.ts#checkout->requires-service->CartRepo",
                  ),
                  RuleGraphToken.make(
                    "EffectSignature:libs/sample/domain/src/checkout.ts#checkout->fails-with->CartEmptyError",
                  ),
                ],
              },
            ],
            targetFiles: [RuleTargetPath.make("libs/harness/gates/src/gc-check.ts")],
            qualityPriorMillis: qualityScore,
          }

          const report = yield* decideRuleSynthesizer(input)
          expect(report.promoted).toBe(true)
          expect(report.rule.patternVariables).toContain("?Scope")
          expect(report.rule.lhsNodes[0]).toContain("?Scope")
          expect(report.rule.nacForbiddenHyperedges).toHaveLength(1)
        }),
    )

    it.effect.prop(
      "rejects synthesized rules with RuleSynthesisError across Stage 1, Stage 3, and Stage 4",
      [
        Schema.Struct({
          taskId: RuleSynthesisTaskId,
        }),
      ],
      ([{ taskId }]) =>
        Effect.gen(function* () {
          // Stage 1 rejection: disjoint node sets (empty interface graph K)
          const stage1Err = yield* Effect.flip(
            decideRuleSynthesizer({
              taskId,
              badGraphNodes: [RuleGraphToken.make("EffectFn:libs/cart/domain/src/a.ts#a")],
              badGraphHyperedges: [
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/a.ts#a"),
              ],
              goodGraphNodes: [RuleGraphToken.make("EffectFn:libs/cart/domain/src/b.ts#b")],
              goodGraphHyperedges: [
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/b.ts#b"),
              ],
              healthyCorpusSnapshots: [],
              targetFiles: [RuleTargetPath.make("libs/harness/gates/src/gc-check.ts")],
            }),
          )
          expect(stage1Err._tag).toBe("RuleSynthesisError")
          expect(stage1Err.stage).toBe("Stage1_PushoutWellFormedness")

          // Stage 3 rejection: false positive match against healthy snapshot in G_Levi
          const stage3Err = yield* Effect.flip(
            decideRuleSynthesizer({
              taskId,
              badGraphNodes: [RuleGraphToken.make("EffectFn:libs/cart/domain/src/cart.ts#run")],
              badGraphHyperedges: [
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/cart.ts#run"),
              ],
              goodGraphNodes: [
                RuleGraphToken.make("EffectFn:libs/cart/domain/src/cart.ts#run"),
                RuleGraphToken.make("Service:libs/cart/service/src/repo.ts#CartRepo"),
              ],
              goodGraphHyperedges: [
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/cart.ts#run"),
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/cart.ts#run->CartRepo"),
              ],
              healthyCorpusSnapshots: [
                {
                  snapshotId: RuleSynthesisTaskId.make("healthy-snap-fp"),
                  isHealthy: RuleSynthesisFlag.make(true),
                  nodeKeys: [RuleGraphToken.make("EffectFn:libs/order/domain/src/cart.ts#run")],
                  hyperedgeSignatures: [
                    RuleGraphToken.make("EffectSignature:libs/order/domain/src/cart.ts#run"),
                  ],
                },
              ],
              targetFiles: [RuleTargetPath.make("libs/harness/gates/src/gc-check.ts")],
            }),
          )
          expect(stage3Err._tag).toBe("RuleSynthesisError")
          expect(stage3Err.stage).toBe("Stage3_ZeroFalsePositive")

          // Stage 4 rejection: Immutable TCB path target
          const stage4Err = yield* Effect.flip(
            decideRuleSynthesizer({
              taskId,
              badGraphNodes: [RuleGraphToken.make("EffectFn:libs/cart/domain/src/cart.ts#run")],
              badGraphHyperedges: [
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/cart.ts#run"),
              ],
              goodGraphNodes: [
                RuleGraphToken.make("EffectFn:libs/cart/domain/src/cart.ts#run"),
                RuleGraphToken.make("Service:libs/cart/service/src/repo.ts#CartRepo"),
              ],
              goodGraphHyperedges: [
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/cart.ts#run"),
                RuleGraphToken.make("EffectSignature:libs/cart/domain/src/cart.ts#run->CartRepo"),
              ],
              healthyCorpusSnapshots: [],
              targetFiles: [RuleTargetPath.make("libs/harness/gates/src/policy.ts")],
            }),
          )
          expect(stage4Err._tag).toBe("RuleSynthesisError")
          expect(stage4Err.stage).toBe("Stage4_ImmutableTcbAndQuality")
          expect(stage4Err.offendingPaths).toEqual(["libs/harness/gates/src/policy.ts"])
        }),
    )

    it.effect.prop(
      "ranks PlanSearch candidates lexicographically by violationCount, cyclomaticComplexity, and cohesionPriorMillis and fails with PlanSearchError when violated",
      [
        Schema.Struct({
          highPrior: PlanSearchScoreMillis.pipe(
            Schema.check(Schema.isBetween({ minimum: 800, maximum: 1000 })),
          ),
          lowPrior: PlanSearchScoreMillis.pipe(
            Schema.check(Schema.isBetween({ minimum: 100, maximum: 500 })),
          ),
        }),
      ],
      ([{ highPrior, lowPrior }]) =>
        Effect.gen(function* () {
          const searchInput: PlanSearchInput = {
            candidates: [
              {
                candidateId: PlanSearchCandidateId.make("plan-complex"),
                worktreeId: PlanSearchWorktreeId.make("wt-complex"),
                summary: PlanSearchSummary.make("High complexity skeleton"),
                violationCount: PlanSearchCount.make(0),
                cyclomaticComplexity: PlanSearchCount.make(9),
                stubHoleCount: PlanSearchCount.make(2),
                cohesionPriorMillis: highPrior,
              },
              {
                candidateId: PlanSearchCandidateId.make("plan-minimal-b"),
                worktreeId: PlanSearchWorktreeId.make("wt-min-b"),
                summary: PlanSearchSummary.make("Minimal skeleton B"),
                violationCount: PlanSearchCount.make(0),
                cyclomaticComplexity: PlanSearchCount.make(3),
                stubHoleCount: PlanSearchCount.make(1),
                cohesionPriorMillis: lowPrior,
              },
              {
                candidateId: PlanSearchCandidateId.make("plan-minimal-a"),
                worktreeId: PlanSearchWorktreeId.make("wt-min-a"),
                summary: PlanSearchSummary.make("Minimal skeleton A"),
                violationCount: PlanSearchCount.make(0),
                cyclomaticComplexity: PlanSearchCount.make(3),
                stubHoleCount: PlanSearchCount.make(1),
                cohesionPriorMillis: highPrior,
              },
            ],
          }

          const report = yield* decidePlanSearch(searchInput)
          expect(report.winner.candidateId).toBe("plan-minimal-a")

          const emptySearchErr = yield* Effect.flip(
            decidePlanSearch({
              candidates: [],
            }),
          )
          expect(emptySearchErr._tag).toBe("PlanSearchError")
          expect(emptySearchErr.candidateCount).toBe(0)

          const allViolatedErr = yield* Effect.flip(
            decidePlanSearch({
              requireZeroViolations: PlanSearchFlag.make(true),
              candidates: [
                {
                  candidateId: PlanSearchCandidateId.make("plan-broken"),
                  worktreeId: PlanSearchWorktreeId.make("wt-broken"),
                  summary: PlanSearchSummary.make("Broken skeleton"),
                  violationCount: PlanSearchCount.make(2),
                  cyclomaticComplexity: PlanSearchCount.make(3),
                  stubHoleCount: PlanSearchCount.make(1),
                },
              ],
            }),
          )
          expect(allViolatedErr._tag).toBe("PlanSearchError")
          expect(allViolatedErr.candidateCount).toBe(1)

          const thrashDecision = yield* decideLoopThrashing(
            [
              {
                timestamp: "t1",
                kind: "verify_failure",
                summary: "verify:semantic",
                detail: "libs/cart/domain/src/cart.ts",
              },
              {
                timestamp: "t2",
                kind: "verify_failure",
                summary: "verify:semantic",
                detail: "libs/cart/domain/src/cart.ts",
              },
              {
                timestamp: "t3",
                kind: "verify_failure",
                summary: "verify:semantic",
                detail: "libs/cart/domain/src/cart.ts",
              },
            ],
            3,
            searchInput.candidates,
          )
          expect(thrashDecision.stuck).toBe(true)
          expect(thrashDecision.recommendedPlanCandidate?.candidateId).toBe("plan-minimal-a")
        }),
    )
  })
})
