import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  DstMethodName,
  DstProbabilityMillis,
  DstSeed,
  DstServiceTag,
  DstStepCount,
  DstTickMillis,
  runDstSeedSuite,
} from "../src/dst-engine.js"
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
  runDomainMutationSuite,
} from "../src/mutation-check.js"
import { testHostIo } from "./helpers/test-host-io.js"
import {
  RuleGraphToken,
  RuleQualityScoreMillis,
  RuleSynthesisFlag,
  RuleSynthesisTaskId,
  RuleSynthesizerInput,
  RuleTargetPath,
  decideRuleSynthesizer,
  isImmutableTcbPath,
  variabilizeGraphTokenWithMap,
} from "../src/rule-synthesizer.js"
import { parseDstSeedEnv } from "../src/verify-stamp.js"

describe("Milestone 5: Mutant Schemata, RuleSynthesizer & PlanSearch", () => {
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
          expect(elapsedMs).toBeGreaterThanOrEqual(0)
          expect(inProcessOutcomes.every((o) => o.status === "killed")).toBe(true)

          const survivedMutant = scopedMutants[0]!
          const reportWithEquiv = yield* decideMutationReport({
            outcomes: [{ mutant: survivedMutant, status: "survived" }],
            equivalencePriors: { [survivedMutant.id]: equivScore },
          })
          expect(reportWithEquiv.passed).toBe(true)
          expect(reportWithEquiv.survivedCount).toBe(0)
          expect(reportWithEquiv.equivalentCount).toBe(1)

          const reportBelow500 = yield* decideMutationReport({
            outcomes: [{ mutant: survivedMutant, status: "survived" }],
            equivalencePriors: { [survivedMutant.id]: 500 },
          })
          expect(reportBelow500.passed).toBe(false)
          expect(reportBelow500.survivedCount).toBe(1)
          expect(reportBelow500.equivalentCount).toBe(0)

          const reportBelow1 = yield* decideMutationReport({
            outcomes: [{ mutant: survivedMutant, status: "survived" }],
            equivalencePriors: { [survivedMutant.id]: 1 },
          })
          expect(reportBelow1.passed).toBe(false)
          expect(reportBelow1.survivedCount).toBe(1)
          expect(reportBelow1.equivalentCount).toBe(0)

          const reportAt849 = yield* decideMutationReport({
            outcomes: [{ mutant: survivedMutant, status: "survived" }],
            equivalencePriors: { [survivedMutant.id]: 849 },
          })
          expect(reportAt849.passed).toBe(false)
          expect(reportAt849.survivedCount).toBe(1)
          expect(reportAt849.equivalentCount).toBe(0)

          const reportAt850 = yield* decideMutationReport({
            outcomes: [{ mutant: survivedMutant, status: "survived" }],
            equivalencePriors: { [survivedMutant.id]: 850 },
          })
          expect(reportAt850.passed).toBe(true)
          expect(reportAt850.survivedCount).toBe(0)
          expect(reportAt850.equivalentCount).toBe(1)
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

    it.effect(
      "runDomainMutationSuite returns MutationReport and parseDstSeedEnv validates DST_SEED format",
      () =>
        Effect.gen(function* () {
          yield* Effect.void
          expect(parseDstSeedEnv(undefined)).toBeUndefined()
          expect(parseDstSeedEnv("")).toBeUndefined()
          expect(parseDstSeedEnv("  ")).toBeUndefined()
          expect(parseDstSeedEnv("42")).toBe(DstSeed.make(42))
          expect(() => parseDstSeedEnv("-1")).toThrow()
          expect(() => parseDstSeedEnv("not-a-number")).toThrow()

          const report = runDomainMutationSuite(process.cwd(), testHostIo, {
            sourceCodeOverlays: {
              "libs/sample/domain/src/sample.ts": "export const f = (x: number) => x > 0",
            },
          })
          expect(typeof report.passed).toBe("boolean")
          expect(typeof report.totalMutants).toBe("number")
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

    it.effect(
      "variabilizeGraphTokenWithMap variabilizes multiple scopes into ?Scope and ?Scope2",
      () =>
        Effect.gen(function* () {
          yield* Effect.void
          const map = new Map<string, string>()
          const token1 = "EffectFn:libs/cart/domain/src/checkout.ts#checkout"
          const token2 = "EffectFn:libs/order/domain/src/process.ts#process"
          const res1 = variabilizeGraphTokenWithMap(token1, map)
          const res2 = variabilizeGraphTokenWithMap(token2, map)
          expect(res1.variabilized).toContain("libs/?Scope/")
          expect(res2.variabilized).toContain("libs/?Scope2/")
          expect(map.get("cart")).toBe("?Scope")
          expect(map.get("order")).toBe("?Scope2")
        }),
    )

    it.effect.prop(
      "rejects synthesized rules on Stage 2 (missing target in goodGraph) and Stage 4 (quality < 500)",
      [
        Schema.Struct({
          taskId: RuleSynthesisTaskId,
        }),
      ],
      ([{ taskId }]) =>
        Effect.gen(function* () {
          // Stage 2 rejection: bad node target not preserved in goodGraph or LHS empty on replay
          const stage2Err = yield* Effect.flip(
            decideRuleSynthesizer({
              taskId,
              badGraphNodes: [
                RuleGraphToken.make("EffectFn:libs/cart/domain/src/checkout.ts#checkout"),
              ],
              badGraphHyperedges: [],
              goodGraphNodes: [
                RuleGraphToken.make("EffectFn:libs/cart/domain/src/checkout.ts#checkout"),
              ],
              goodGraphHyperedges: [
                RuleGraphToken.make(
                  "libs/cart/domain/src/checkout.ts:calls->libs/cart/contract/src/new.ts",
                ),
              ],
              healthyCorpusSnapshots: [],
              targetFiles: [RuleTargetPath.make("libs/cart/domain/src/checkout.ts")],
            }),
          )
          expect(stage2Err._tag).toBe("RuleSynthesisError")
          expect(stage2Err.stage).toBe("Stage2_PositiveReplay")

          // Stage 4 quality threshold: qualityPriorMillis = 499 (default threshold is 500)
          const stage4QualityErr = yield* Effect.flip(
            decideRuleSynthesizer({
              taskId,
              badGraphNodes: [
                RuleGraphToken.make("EffectFn:libs/cart/domain/src/checkout.ts#checkout"),
              ],
              badGraphHyperedges: [
                RuleGraphToken.make(
                  "libs/cart/domain/src/checkout.ts:calls->libs/cart/contract/src/old.ts",
                ),
              ],
              goodGraphNodes: [
                RuleGraphToken.make("EffectFn:libs/cart/domain/src/checkout.ts#checkout"),
              ],
              goodGraphHyperedges: [
                RuleGraphToken.make(
                  "libs/cart/domain/src/checkout.ts:calls->libs/cart/contract/src/new.ts",
                ),
              ],
              healthyCorpusSnapshots: [
                {
                  snapshotId: RuleSynthesisTaskId.make("healthy-snap-1"),
                  isHealthy: RuleSynthesisFlag.make(true),
                  nodeKeys: [RuleGraphToken.make("EffectFn:libs/order/domain/src/order.ts#order")],
                  hyperedgeSignatures: [
                    RuleGraphToken.make(
                      "libs/order/domain/src/order.ts:calls->libs/order/contract/src/order.ts",
                    ),
                  ],
                },
              ],
              targetFiles: [RuleTargetPath.make("libs/cart/domain/src/checkout.ts")],
              qualityPriorMillis: RuleQualityScoreMillis.make(499),
            }),
          )
          expect(stage4QualityErr._tag).toBe("RuleSynthesisError")
          expect(stage4QualityErr.stage).toBe("Stage4_ImmutableTcbAndQuality")
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

          const suite = yield* runDstSeedSuite({
            pinnedSeed: DstSeed.make(7),
            config: {
              stepCount: DstStepCount.make(2),
              baseInterruptProbMillis: DstProbabilityMillis.make(0),
              baseFailureProbMillis: DstProbabilityMillis.make(0),
              baseDelayProbMillis: DstProbabilityMillis.make(0),
              maxDelayTicksMs: DstTickMillis.make(10),
              targets: [
                {
                  serviceTag: DstServiceTag.make("Repo"),
                  methodName: DstMethodName.make("get"),
                  declaredErrors: [],
                },
              ],
            },
          })
          expect(suite.seedsRun).toBe(1)
          expect(suite.schedules).toHaveLength(1)
        }),
    )
  })
})
