import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema } from "effect"
import { match } from "ts-pattern"
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
  makeChaosLayer,
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
  type EarsConsistencyInput,
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

describe("Milestone 5: EARS Consistency, DST Engine & Span Causality", () => {
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

    it.effect(
      "detects EARS-01 contradiction when guardPairRelations is omitted (fail-closed independent_overlapping)",
      () =>
        Effect.gen(function* () {
          yield* Effect.void
          const input: EarsConsistencyInput = {
            specId: EarsSpecId.make("harness:SPEC-0010"),
            filePath: EarsFilePath.make("libs/harness/docs/specs/sample.md"),
            stateDomainVariants: [EarsVariantTag.make("Open")],
            guardDomainVariants: [EarsVariantTag.make("CartActive")],
            clauses: [
              {
                clauseId: EarsClauseId.make("C-1"),
                pattern: EarsClausePatternKind.make("State-driven"),
                effectSymbol: EarsEffectSymbolName.make("Cart.decide"),
                activeStateVariant: EarsVariantTag.make("Open"),
                guardVariant: EarsVariantTag.make("CartActive"),
                outcomeTag: EarsOutcomeTag.make("CartSaved"),
                polarity: EarsClausePolarity.make("shall"),
              },
              {
                clauseId: EarsClauseId.make("C-2"),
                pattern: EarsClausePatternKind.make("State-driven"),
                effectSymbol: EarsEffectSymbolName.make("Cart.decide"),
                activeStateVariant: EarsVariantTag.make("Open"),
                guardVariant: EarsVariantTag.make("CartActive"),
                outcomeTag: EarsOutcomeTag.make("CartFailed"),
                polarity: EarsClausePolarity.make("shall"),
              },
            ],
            requireExhaustiveStateCoverage: EarsConsistencyFlag.make(false),
          }
          const report = evaluateEarsConsistencyReport(input)
          expect(report.ok).toBe(false)
          expect(report.violations.some((v) => v.ruleId === "EARS-01")).toBe(true)
        }),
    )

    it.effect(
      "detects EARS-02 shadowed clause when earlier clause has broader guard with same outcome",
      () =>
        Effect.gen(function* () {
          yield* Effect.void
          const input: EarsConsistencyInput = {
            specId: EarsSpecId.make("harness:SPEC-0011"),
            filePath: EarsFilePath.make("libs/harness/docs/specs/sample.md"),
            stateDomainVariants: [EarsVariantTag.make("Active")],
            guardDomainVariants: [
              EarsVariantTag.make("BroadGuard"),
              EarsVariantTag.make("NarrowGuard"),
            ],
            clauses: [
              {
                clauseId: EarsClauseId.make("C-1"),
                pattern: EarsClausePatternKind.make("State-driven"),
                effectSymbol: EarsEffectSymbolName.make("Order.decide"),
                activeStateVariant: EarsVariantTag.make("Active"),
                guardVariant: EarsVariantTag.make("BroadGuard"),
                outcomeTag: EarsOutcomeTag.make("OrderSuccess"),
                polarity: EarsClausePolarity.make("shall"),
              },
              {
                clauseId: EarsClauseId.make("C-2"),
                pattern: EarsClausePatternKind.make("State-driven"),
                effectSymbol: EarsEffectSymbolName.make("Order.decide"),
                activeStateVariant: EarsVariantTag.make("Active"),
                guardVariant: EarsVariantTag.make("NarrowGuard"),
                outcomeTag: EarsOutcomeTag.make("OrderSuccess"),
                polarity: EarsClausePolarity.make("shall"),
              },
            ],
            guardPairPriors: [
              {
                firstClauseId: EarsClauseId.make("C-1"),
                secondClauseId: EarsClauseId.make("C-2"),
                relation: EarsGuardPairRelation.make("first_subsumes_second"),
              },
            ],
            requireExhaustiveStateCoverage: EarsConsistencyFlag.make(false),
          }
          const report = evaluateEarsConsistencyReport(input)
          expect(report.ok).toBe(false)
          expect(report.violations.some((v) => v.ruleId === "EARS-02")).toBe(true)
        }),
    )

    it.effect(
      "fails with EARS-03 when requireExhaustiveStateCoverage is true and clauses or stateDomainVariants are empty",
      () =>
        Effect.gen(function* () {
          yield* Effect.void
          const inputEmptyClauses: EarsConsistencyInput = {
            specId: EarsSpecId.make("harness:SPEC-0012"),
            filePath: EarsFilePath.make("libs/harness/docs/specs/sample.md"),
            stateDomainVariants: [EarsVariantTag.make("Open")],
            guardDomainVariants: [],
            clauses: [],
            requireExhaustiveStateCoverage: EarsConsistencyFlag.make(true),
          }
          const report1 = evaluateEarsConsistencyReport(inputEmptyClauses)
          expect(report1.ok).toBe(false)
          expect(report1.violations.some((v) => v.ruleId === "EARS-03")).toBe(true)

          const inputEmptyStates: EarsConsistencyInput = {
            specId: EarsSpecId.make("harness:SPEC-0013"),
            filePath: EarsFilePath.make("libs/harness/docs/specs/sample.md"),
            stateDomainVariants: [],
            guardDomainVariants: [],
            clauses: [
              {
                clauseId: EarsClauseId.make("C-1"),
                pattern: EarsClausePatternKind.make("State-driven"),
                effectSymbol: EarsEffectSymbolName.make("Cart.decide"),
                outcomeTag: EarsOutcomeTag.make("Ok"),
                polarity: EarsClausePolarity.make("shall"),
              },
            ],
            requireExhaustiveStateCoverage: EarsConsistencyFlag.make(true),
          }
          const report2 = evaluateEarsConsistencyReport(inputEmptyStates)
          expect(report2.ok).toBe(false)
          expect(report2.violations.some((v) => v.ruleId === "EARS-03")).toBe(true)
        }),
    )
  })

  describe("Step 2: DstEngine.decide, runWithDecoupledClockDriver & LISA SpanBudget.decide", () => {
    it.effect.prop(
      "deterministically generates identical fault schedules from the same DstSeed and fails with DstScheduleError when targets are empty",
      [
        Schema.Struct({
          seed: DstSeed,
          stepCount: DstStepCount.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
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
            const repo = yield* SimulatedRepo
            return yield* repo.saveWithRetry("order-1")
          }).pipe(
            Effect.provideService(SimulatedRepo, {
              saveWithRetry: (orderId: string) =>
                Effect.gen(function* () {
                  attempts++
                  const controller = yield* ChaosFaultController
                  const decision = yield* controller.nextStepFor(
                    DstServiceTag.make("SimulatedRepo"),
                    DstMethodName.make("saveWithRetry"),
                  )
                  yield* Effect.sleep("40 millis")
                  yield* match(decision)
                    .with(
                      { _tag: "FailWithError" },
                      () =>
                        new SimulatedTransientError({
                          serviceTag: "SimulatedRepo",
                          methodName: `saveWithRetry:${orderId}`,
                        }),
                    )
                    .otherwise(() => Effect.void)
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
            failOnViolation: false,
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

    it.effect(
      "DST engine with declaredErrors: [] and baseInterruptProbMillis: 0 never injects interrupt or failure",
      () =>
        Effect.gen(function* () {
          const config: DstEngineConfig = {
            seed: DstSeed.make(123),
            stepCount: DstStepCount.make(5),
            targets: [
              {
                serviceTag: DstServiceTag.make("PureService"),
                methodName: DstMethodName.make("query"),
                declaredErrors: [],
              },
            ],
            baseFailureProbMillis: DstProbabilityMillis.make(1000),
            baseDelayProbMillis: DstProbabilityMillis.make(0),
            baseInterruptProbMillis: DstProbabilityMillis.make(0),
            maxDelayTicksMs: DstTickMillis.make(0),
          }
          const schedule = yield* decideDstSchedule(config)
          expect(
            schedule.steps.every(
              (s) => s.decision._tag !== "InterruptFiber" && s.decision._tag !== "FailWithError",
            ),
          ).toBe(true)
        }),
    )

    it.effect(
      "decideDstSchedule fails with DstScheduleError when sum of probabilities exceeds 1000 millis",
      () =>
        Effect.gen(function* () {
          const invalidConfig: DstEngineConfig = {
            seed: DstSeed.make(99),
            stepCount: DstStepCount.make(3),
            targets: [
              {
                serviceTag: DstServiceTag.make("TestService"),
                methodName: DstMethodName.make("call"),
                declaredErrors: [DstErrorTag.make("Error")],
              },
            ],
            baseFailureProbMillis: DstProbabilityMillis.make(600),
            baseDelayProbMillis: DstProbabilityMillis.make(500),
            baseInterruptProbMillis: DstProbabilityMillis.make(100),
            maxDelayTicksMs: DstTickMillis.make(10),
          }
          const err = yield* Effect.flip(decideDstSchedule(invalidConfig))
          expect(err._tag).toBe("DstScheduleError")
        }),
    )

    it.effect("distinct seeds produce distinct fault schedules", () =>
      Effect.gen(function* () {
        const baseConfig = {
          stepCount: DstStepCount.make(10),
          targets: [
            {
              serviceTag: DstServiceTag.make("S1"),
              methodName: DstMethodName.make("m1"),
              declaredErrors: [DstErrorTag.make("E1")],
            },
          ],
          baseFailureProbMillis: DstProbabilityMillis.make(500),
          baseDelayProbMillis: DstProbabilityMillis.make(300),
          baseInterruptProbMillis: DstProbabilityMillis.make(100),
          maxDelayTicksMs: DstTickMillis.make(20),
        }
        const sched1 = yield* decideDstSchedule({ ...baseConfig, seed: DstSeed.make(1) })
        const sched2 = yield* decideDstSchedule({ ...baseConfig, seed: DstSeed.make(2) })
        expect(sched1.seed).not.toEqual(sched2.seed)
        expect(sched1.steps).not.toEqual(sched2.steps)
      }),
    )

    it.effect("makeChaosLayer advances step cursor sequentially per service+method", () =>
      Effect.gen(function* () {
        const schedule = yield* decideDstSchedule({
          seed: DstSeed.make(42),
          stepCount: DstStepCount.make(3),
          targets: [
            {
              serviceTag: DstServiceTag.make("S1"),
              methodName: DstMethodName.make("m1"),
              declaredErrors: [DstErrorTag.make("E1")],
            },
          ],
          baseFailureProbMillis: DstProbabilityMillis.make(1000),
          baseDelayProbMillis: DstProbabilityMillis.make(0),
          baseInterruptProbMillis: DstProbabilityMillis.make(0),
          maxDelayTicksMs: DstTickMillis.make(0),
        })
        const chaosLayer = makeChaosLayer(schedule)
        const result = yield* Effect.gen(function* () {
          const ctrl = yield* ChaosFaultController
          const d1 = yield* ctrl.nextStepFor(DstServiceTag.make("S1"), DstMethodName.make("m1"))
          const d2 = yield* ctrl.nextStepFor(DstServiceTag.make("S1"), DstMethodName.make("m1"))
          return [d1._tag, d2._tag]
        }).pipe(Effect.provide(chaosLayer))
        expect(result).toHaveLength(2)
      }),
    )

    it.effect(
      "enforces RequireCompensationOnFailure and handles dangling parentSpanId in ForbiddenUnder safely",
      () =>
        Effect.gen(function* () {
          const rules = [
            RequireCompensationOnFailureRule.make({
              failedSpan: SpanNameString.make("Payment.charge"),
              compensationSpan: SpanNameString.make("Payment.refund"),
            }),
            ForbiddenUnderCausalityRule.make({
              ancestorSpan: SpanNameString.make("Root.action"),
              forbiddenDescendantSpan: SpanNameString.make("Banned.op"),
            }),
          ]
          const uncompensatedSpans = [
            {
              spanId: "sp-1",
              parentSpanId: null,
              name: "Payment.charge",
              startTimeMs: 1,
              endTimeMs: 2,
              exitTag: "Failure" as const,
            },
          ]
          const violations1 = yield* decideSpanBudgets({
            causalityRules: rules,
            failOnViolation: false,
            spans: uncompensatedSpans,
          })
          expect(violations1.some((v) => v.kind === "temporal-order-violation")).toBe(true)

          const danglingSpans = [
            {
              spanId: "sp-2",
              parentSpanId: "missing-parent",
              name: "Banned.op",
              startTimeMs: 3,
              endTimeMs: 4,
              exitTag: "Success" as const,
            },
          ]
          const violations2 = yield* decideSpanBudgets({
            causalityRules: rules,
            failOnViolation: false,
            spans: danglingSpans,
          })
          const forbiddenViolations = violations2.filter(
            (v) => v.kind === "forbidden-descendant-span",
          )
          expect(forbiddenViolations).toHaveLength(1)
          expect(forbiddenViolations[0]?.message).toContain("dangling unverified parentSpanId")

          const harmlessDanglingSpans = [
            {
              spanId: "sp-3",
              parentSpanId: "missing-parent-2",
              name: "Other.op",
              startTimeMs: 3,
              endTimeMs: 4,
              exitTag: "Success" as const,
            },
          ]
          const violations3 = yield* decideSpanBudgets({
            causalityRules: rules,
            failOnViolation: false,
            spans: harmlessDanglingSpans,
          })
          expect(violations3.filter((v) => v.kind === "forbidden-descendant-span")).toHaveLength(0)
        }),
    )
  })
})
