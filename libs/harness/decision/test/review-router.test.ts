import { Cause, Effect, Fiber, Layer, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "@effect/vitest"
import {
  NxScopeTag,
  NxTierTag,
  REVIEW_DEPTH_RANK,
  REVIEW_SLICE_FILE_THRESHOLD,
  RemediationFindingSeverity,
  RemediationReviewContext,
  ReviewChangedLines,
  ReviewDepth,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewSignalPath,
  ReviewSummaryText,
  ReviewTimeoutMillis,
  ReviewerId,
  compareCodeUnits,
  getReviewDepthRank,
} from "@harness/contract"
import { match } from "ts-pattern"
import { validateDecisionLimits } from "../src/idiom-router.js"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "../src/mock-layer.js"
import {
  ReviewRouterV1,
  attachReviewSlicesIfThresholdReached,
  decideDeterministicReviewRoute,
  inferReviewDiffSignals,
  normalizeReviewFilePaths,
  routeReviewDiff,
} from "../src/review-router-decision.js"
import {
  partitionDiffReviewSlices,
  resolveReviewSliceUnitKey,
} from "../src/review-slice-partitioner.js"

const SafeRelativePathArb = Schema.Literals([
  "docs/notes.md",
  "./apps/sample-web/src/App.tsx",
  "apps\\sample-web\\src\\App.tsx",
  "libs/sample/contract/src/index.ts",
  "libs/sample/domain/src/album.ts",
  "libs/sample/infra/migrations/0001_init.sql",
  "libs/harness/decision/src/review-router-decision.ts",
  "./libs\\harness\\service\\src\\host-io.ts",
  "adapters/antigravity/plugins/effect-harness/README.md",
])

const DiffSummaryArb = Schema.Literals(["", "AtomHttpApi", "Redacted auth token", "SqliteMigrator"])

const BoundaryProbArb = Schema.Literals([0, 0.74, 0.75, 1])

const ReviewPropInputArb = Schema.Struct({
  files: Schema.Array(SafeRelativePathArb).pipe(Schema.check(Schema.isBetweenLength(1, 8))),
  diffSummary: DiffSummaryArb,
  changedLineCount: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.check(Schema.isLessThanOrEqualTo(500)),
  ),
  touchedTiers: Schema.Array(NxTierTag),
  touchedScopes: Schema.Array(NxScopeTag),
  modelDepth: ReviewDepth,
  secProb: BoundaryProbArb,
  relProb: BoundaryProbArb,
  advProb: BoundaryProbArb,
  migProb: BoundaryProbArb,
  archProb: BoundaryProbArb,
})

const routeDeterministicOnly = (
  changedFiles: ReadonlyArray<string>,
  diffSummary: string,
  changedLineCount: number,
  touchedTiers: ReadonlyArray<NxTierTag> = [],
  touchedScopes: ReadonlyArray<NxScopeTag> = [],
) =>
  Effect.gen(function* () {
    const signals = yield* inferReviewDiffSignals(
      ReviewRawDiffInput.make({
        changedFiles: changedFiles.map((f) => ReviewRawFileInput.make(f)),
        diffSummary: ReviewSummaryText.make(diffSummary),
        changedLineCount: ReviewChangedLines.make(changedLineCount),
        touchedTiers,
        touchedScopes,
      }),
    )
    return yield* decideDeterministicReviewRoute(signals)
  })

describe("ReviewRouterV1 and monotonic hybrid review routing", () => {
  it.effect("validates ReviewRouterV1 against Ollama System One limits", () =>
    validateDecisionLimits(ReviewRouterV1),
  )

  it.effect("REQ-1.1: normalizes paths, deduplicates, and infers surface flags", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeReviewFilePaths([
        ReviewRawFileInput.make("./apps\\sample-web\\src\\App.tsx"),
        ReviewRawFileInput.make("apps/sample-web/src/App.tsx"),
      ])
      expect(normalized).toEqual(["apps/sample-web/src/App.tsx"])

      const signals = yield* inferReviewDiffSignals(
        ReviewRawDiffInput.make({
          changedFiles: [
            ReviewRawFileInput.make("./apps\\sample-web\\src\\App.tsx"),
            ReviewRawFileInput.make("apps/sample-web/src/App.tsx"),
            ReviewRawFileInput.make("libs/sample/infra/migrations/0001_init.sql"),
          ],
          diffSummary: ReviewSummaryText.make("Update AtomHttpApi client and D1Database migration"),
          changedLineCount: ReviewChangedLines.make(45),
          touchedTiers: [NxTierTag.make("type:infra")],
          touchedScopes: [NxScopeTag.make("scope:web")],
        }),
      )

      expect(signals.changedFiles).toEqual([
        "apps/sample-web/src/App.tsx",
        "libs/sample/infra/migrations/0001_init.sql",
      ])
      expect(signals.hasWebSurface).toBe(true)
      expect(signals.hasMigrationOrInfraBindingChange).toBe(true)
      expect(signals.hasConcurrencyOrResourceChange).toBe(true)
      expect(signals.hasTestOrSpecChange).toBe(false)
    }),
  )

  it.effect(
    "REQ-1.2: rejects empty, null-byte, absolute, drive, and evasion paths with InvalidReviewRouteInputError",
    () =>
      Effect.gen(function* () {
        const badPaths = [
          "",
          "   ",
          "foo\0bar.ts",
          "/etc/passwd",
          ".//etc/passwd",
          "./\\etc\\passwd",
          "C:\\repo\\a.ts",
          "./C:/repo/a.ts",
          "C:secret.ts",
          ".",
          "./.",
          "../secret.ts",
          "a/../b.ts",
          "a//b.ts",
          "a/./b.ts",
          "./ foo.ts",
        ]
        for (const badPath of badPaths) {
          const exit = yield* Effect.exit(
            inferReviewDiffSignals(
              ReviewRawDiffInput.make({
                changedFiles: [ReviewRawFileInput.make(badPath)],
                diffSummary: ReviewSummaryText.make(""),
                changedLineCount: ReviewChangedLines.make(1),
                touchedTiers: [],
                touchedScopes: [],
              }),
            ),
          )
          match(exit)
            .with({ _tag: "Failure" }, ({ cause }) => {
              match(Cause.findErrorOption(cause))
                .with({ _tag: "Some" }, ({ value }) => {
                  expect(value._tag).toBe("InvalidReviewRouteInputError")
                  expect(value.offendingPath).toBe(badPath)
                  expect(value.reason.length).toBeGreaterThan(0)
                })
                .with({ _tag: "None" }, () => {
                  expect.unreachable(`Expected InvalidReviewRouteInputError for "${badPath}"`)
                })
                .exhaustive()
            })
            .with({ _tag: "Success" }, () => {
              expect.unreachable(`Expected failure for "${badPath}"`)
            })
            .exhaustive()
        }
      }),
  )

  it.effect(
    "F-2.1b: rejects empty changedFiles with InvalidReviewRouteInputError / Schema rejection (never SkipReviewPlan)",
    () =>
      Effect.gen(function* () {
        const emptyExit = yield* Effect.exit(normalizeReviewFilePaths([]))
        expect(
          match(emptyExit)
            .with({ _tag: "Failure" }, ({ cause }) =>
              match(Cause.findErrorOption(cause))
                .with(
                  { _tag: "Some" },
                  ({ value }) => value._tag === "InvalidReviewRouteInputError",
                )
                .with({ _tag: "None" }, () => false)
                .exhaustive(),
            )
            .with({ _tag: "Success" }, () => false)
            .exhaustive(),
        ).toBe(true)

        const schemaExit = yield* Effect.exit(
          Schema.decodeEffect(ReviewRawDiffInput)({
            changedFiles: [],
            diffSummary: "",
            changedLineCount: 0,
            touchedTiers: [],
            touchedScopes: [],
          }),
        )
        expect(
          match(schemaExit)
            .with({ _tag: "Failure" }, ({ cause }) => Cause.hasFails(cause))
            .with({ _tag: "Success" }, () => false)
            .exhaustive(),
        ).toBe(true)
      }),
  )

  it.effect(
    "F-14.1a: rejects over-512 normalized path and over-200 changedFiles with InvalidReviewRouteInputError",
    () =>
      Effect.gen(function* () {
        const over512 = ReviewRawFileInput.make(`${"a".repeat(510)}.ts`, { disableChecks: true })
        const pathExit = yield* Effect.exit(normalizeReviewFilePaths([over512]))
        expect(
          match(pathExit)
            .with({ _tag: "Failure" }, ({ cause }) =>
              match(Cause.findErrorOption(cause))
                .with(
                  { _tag: "Some" },
                  ({ value }) => value._tag === "InvalidReviewRouteInputError",
                )
                .with({ _tag: "None" }, () => false)
                .exhaustive(),
            )
            .with({ _tag: "Success" }, () => false)
            .exhaustive(),
        ).toBe(true)

        const manyFiles = Array.from({ length: 201 }, (_, idx) =>
          ReviewRawFileInput.make(`docs/file-${idx}.md`),
        )
        const arrayInput = ReviewRawDiffInput.make(
          {
            changedFiles: manyFiles,
            diffSummary: ReviewSummaryText.make(""),
            changedLineCount: ReviewChangedLines.make(1),
            touchedTiers: [],
            touchedScopes: [],
          },
          { disableChecks: true },
        )
        const arrayExit = yield* Effect.exit(inferReviewDiffSignals(arrayInput))
        expect(
          match(arrayExit)
            .with({ _tag: "Failure" }, ({ cause }) =>
              match(Cause.findErrorOption(cause))
                .with(
                  { _tag: "Some" },
                  ({ value }) => value._tag === "InvalidReviewRouteInputError",
                )
                .with({ _tag: "None" }, () => false)
                .exhaustive(),
            )
            .with({ _tag: "Success" }, () => false)
            .exhaustive(),
        ).toBe(true)
      }),
  )

  it.effect(
    "REQ-2.1 & REQ-2.2: returns SkipReviewPlan for trivial non-governance docs < 40 lines, and promotes at 40 lines",
    () =>
      Effect.gen(function* () {
        const doc39Plan = yield* routeDeterministicOnly(
          ["docs/changelog.md"],
          "Fix typo in changelog",
          39,
        )
        expect(doc39Plan._tag).toBe("SkipReviewPlan")
        expect(doc39Plan.depth).toBe("skip")

        const licensePlan = yield* routeDeterministicOnly(["LICENSE"], "Update year", 2)
        expect(licensePlan._tag).toBe("SkipReviewPlan")

        const doc40Plan = yield* routeDeterministicOnly(
          ["docs/changelog.md"],
          "Large doc rewrite",
          40,
        )
        expect(doc40Plan._tag).toBe("ActiveReviewPlan")
        expect(doc40Plan.depth).toBe("focused")
        expect(doc40Plan.selections.map((s) => s.reviewer)).toContain(
          ReviewerId.make("effect-architecture-reviewer"),
        )
      }),
  )

  it.effect(
    "F-1.1: non-doc non-.ts files under 40 lines route to ActiveReviewPlan (>= lite) and never skip",
    () =>
      Effect.gen(function* () {
        const nonDocFiles = [
          "tools/check.mjs",
          ".oxlintrc.json",
          "package.json",
          ".github/workflows/ci.yml",
          "tsconfig.json",
          "scripts/setup.sh",
          "db/seed.sql",
        ]
        for (const filePath of nonDocFiles) {
          const plan = yield* routeDeterministicOnly([filePath], "Small config/script change", 5)
          expect(plan._tag).toBe("ActiveReviewPlan")
          expect(getReviewDepthRank(plan.depth)).toBeGreaterThanOrEqual(REVIEW_DEPTH_RANK.lite)
          expect(plan.selections.every((s) => s.mandatory)).toBe(true)
        }

        const tsPlan = yield* routeDeterministicOnly(["scripts/helper.ts"], "Small helper", 5)
        expect(tsPlan._tag).toBe("ActiveReviewPlan")
        expect(tsPlan.depth).toBe("lite")
        expect(tsPlan.selections.map((s) => s.reviewer)).toEqual([
          ReviewerId.make("effect-ears-test-reviewer"),
        ])
      }),
  )

  it.effect(
    "F-16.1: tightens hasAuthOrSecretSurface and hasTestOrSpecChange against false positives",
    () =>
      Effect.gen(function* () {
        const benignSignals = yield* inferReviewDiffSignals(
          ReviewRawDiffInput.make({
            changedFiles: [
              ReviewRawFileInput.make("libs/sample/src/author.ts"),
              ReviewRawFileInput.make("libs/sample/src/tokenizer.ts"),
              ReviewRawFileInput.make("libs/sample/test/adapter-config.test.ts"),
            ],
            diffSummary: ReviewSummaryText.make("Update Config and sql"),
            changedLineCount: ReviewChangedLines.make(12),
            touchedTiers: [],
            touchedScopes: [],
          }),
        )
        expect(benignSignals.hasAuthOrSecretSurface).toBe(false)
        expect(benignSignals.hasTestOrSpecChange).toBe(true)

        for (const authFile of [
          "libs/sample/auth/policy.ts",
          "libs/sample/src/session-store.ts",
          "libs/sample/src/auth_token.ts",
          "libs/sample/src/secrets.ts",
        ]) {
          const authSignals = yield* inferReviewDiffSignals(
            ReviewRawDiffInput.make({
              changedFiles: [ReviewRawFileInput.make(authFile)],
              diffSummary: ReviewSummaryText.make("Update"),
              changedLineCount: ReviewChangedLines.make(5),
              touchedTiers: [],
              touchedScopes: [],
            }),
          )
          expect(authSignals.hasAuthOrSecretSurface).toBe(true)
        }
      }),
  )

  it.effect("S-5.2 / REQ-2.3 (1): lite depth for single EARS spec under 40 lines", () =>
    Effect.gen(function* () {
      const litePlan = yield* routeDeterministicOnly(
        ["libs/sample/docs/specs/2026-11-17-feature.md"],
        "Add EARS spec",
        25,
      )
      expect(litePlan._tag).toBe("ActiveReviewPlan")
      expect(litePlan.depth).toBe("lite")
      expect(litePlan.selections.map((s) => s.reviewer)).toEqual([
        ReviewerId.make("effect-ears-test-reviewer"),
      ])
      expect(litePlan.selections.every((s) => s.mandatory)).toBe(true)
    }),
  )

  it.effect("S-5.2 / F-4.1a / REQ-2.3 (2): stateful/decider dual-review routes at full depth", () =>
    Effect.gen(function* () {
      const deciderPlan = yield* routeDeterministicOnly(
        ["libs/sample/domain/src/album.ts"],
        "Update decider",
        20,
        [NxTierTag.make("type:domain")],
      )
      expect(deciderPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-ears-test-reviewer"),
      )
      expect(deciderPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-adversarial-reviewer"),
      )
      expect(deciderPlan.depth).toBe("full")
      expect(deciderPlan.selections.every((s) => s.mandatory)).toBe(true)
    }),
  )

  it.effect(
    "S-5.2 / S-2.1 / REQ-2.3 (3): security lens floors single security-surface selection at focused depth",
    () =>
      Effect.gen(function* () {
        const secPlan = yield* routeDeterministicOnly(
          ["libs/sample/auth/policy.ts"],
          "Check token",
          10,
        )
        expect(secPlan.selections.map((s) => s.reviewer)).toContain(
          ReviewerId.make("effect-security-reviewer"),
        )
        expect(secPlan.depth).toBe("focused")
        expect(secPlan.selections.every((s) => s.mandatory)).toBe(true)
      }),
  )

  it.effect("S-5.2 / F-4.1a / REQ-2.3 (4): reliability lens covers D1, Queue, and alarm", () =>
    Effect.gen(function* () {
      const relPlan = yield* routeDeterministicOnly(
        ["libs/sample/infra/src/repo.ts"],
        "Use D1Database, Queue, and alarm",
        10,
        [NxTierTag.make("type:infra")],
      )
      expect(relPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-reliability-reviewer"),
      )
    }),
  )

  it.effect("S-5.2 / REQ-2.3 (5): web lens routes scope:web and AtomHttpApi", () =>
    Effect.gen(function* () {
      const webPlan = yield* routeDeterministicOnly(
        ["apps/sample-web/src/App.tsx"],
        "Update AtomHttpApi",
        10,
        [],
        [NxScopeTag.make("scope:web")],
      )
      expect(webPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-web-reviewer"),
      )
    }),
  )

  it.effect("S-5.2 / F-4.1a / REQ-2.3 (6): migration & OpenAPI contract lenses", () =>
    Effect.gen(function* () {
      const migPlan = yield* routeDeterministicOnly(
        ["libs/sample/infra/migrations/0002_idx.sql"],
        "Add index",
        10,
      )
      expect(migPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-migration-contract-reviewer"),
      )
      expect(migPlan.depth).toBe("full")

      const openapiPlan = yield* routeDeterministicOnly(["api/openapi.yaml"], "Add endpoint", 15)
      expect(openapiPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-migration-contract-reviewer"),
      )
      expect(openapiPlan.depth).toBe("focused")
    }),
  )

  it.effect("S-5.2 / REQ-2.3 (7): architecture lens and 179 vs 180 line boundary", () =>
    Effect.gen(function* () {
      const plan179 = yield* routeDeterministicOnly(
        ["libs/sample/service/src/ports.ts"],
        "Update port",
        179,
        [NxTierTag.make("type:service")],
      )
      expect(plan179.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-architecture-reviewer"),
      )
      expect(plan179.depth).toBe("focused")

      const plan180 = yield* routeDeterministicOnly(
        ["libs/sample/service/src/ports.ts"],
        "Update port",
        180,
        [NxTierTag.make("type:service")],
      )
      expect(plan180.depth).toBe("full")
    }),
  )

  it.effect(
    "F-6.1b: deterministic never-downgrade invariants across full/focused/lite floors",
    () =>
      Effect.gen(function* () {
        const fullInput = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("libs/sample/infra/migrations/0002_idx.sql")],
          diffSummary: ReviewSummaryText.make("Add index"),
          changedLineCount: ReviewChangedLines.make(10),
          touchedTiers: [],
          touchedScopes: [],
        })
        const focusedInput = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("libs/sample/auth/policy.ts")],
          diffSummary: ReviewSummaryText.make("Check token"),
          changedLineCount: ReviewChangedLines.make(10),
          touchedTiers: [],
          touchedScopes: [],
        })
        const liteInput = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("libs/sample/docs/specs/2026-11-17-feature.md")],
          diffSummary: ReviewSummaryText.make("Add spec"),
          changedLineCount: ReviewChangedLines.make(10),
          touchedTiers: [],
          touchedScopes: [],
        })

        const zeroProbs = {
          needsSecurityProb: 0,
          needsReliabilityProb: 0,
          needsAdversarialProb: 0,
          needsMigrationContractProb: 0,
          needsArchitectureProb: 0,
        }

        const fullSkip = yield* routeReviewDiff(fullInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              ...zeroProbs,
            }),
          ),
        )
        expect(fullSkip.depth).toBe("full")

        const fullLite = yield* routeReviewDiff(fullInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("lite"),
              ...zeroProbs,
            }),
          ),
        )
        expect(fullLite.depth).toBe("full")

        const focusedSkip = yield* routeReviewDiff(focusedInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              ...zeroProbs,
            }),
          ),
        )
        expect(focusedSkip.depth).toBe("focused")

        const focusedLite = yield* routeReviewDiff(focusedInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("lite"),
              ...zeroProbs,
            }),
          ),
        )
        expect(focusedLite.depth).toBe("focused")

        const liteSkip = yield* routeReviewDiff(liteInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              ...zeroProbs,
            }),
          ),
        )
        expect(liteSkip.depth).toBe("lite")
      }),
  )

  it.effect.prop(
    "REQ-3.1: routeReviewDiff is monotonic (never lowers depth and preserves all deterministic floor reviewers)",
    [ReviewPropInputArb],
    ([sample]) =>
      Effect.gen(function* () {
        const input = ReviewRawDiffInput.make({
          changedFiles: sample.files.map((f) => ReviewRawFileInput.make(f)),
          diffSummary: ReviewSummaryText.make(sample.diffSummary),
          changedLineCount: ReviewChangedLines.make(sample.changedLineCount),
          touchedTiers: sample.touchedTiers,
          touchedScopes: sample.touchedScopes,
        })

        const signals = yield* inferReviewDiffSignals(input)
        const floorPlan = yield* decideDeterministicReviewRoute(signals)

        const mockLayer = makeMockDecisionModelLayer({
          reviewDepthLabel: sample.modelDepth,
          needsSecurityProb: sample.secProb,
          needsReliabilityProb: sample.relProb,
          needsAdversarialProb: sample.advProb,
          needsMigrationContractProb: sample.migProb,
          needsArchitectureProb: sample.archProb,
        })

        const routedPlan = yield* routeReviewDiff(input, signals).pipe(Effect.provide(mockLayer))

        expect(getReviewDepthRank(routedPlan.depth)).toBeGreaterThanOrEqual(
          getReviewDepthRank(floorPlan.depth),
        )
        const routedReviewerIds = new Set(routedPlan.selections.map((s) => s.reviewer))
        for (const floorSel of floorPlan.selections) {
          expect(routedReviewerIds.has(floorSel.reviewer)).toBe(true)
        }
        const planChanged =
          routedPlan.depth !== floorPlan.depth ||
          routedPlan.selections.length > floorPlan.selections.length
        expect(routedPlan.source).toBe(planChanged ? "model-augmented" : "deterministic")
      }),
  )

  it.effect(
    "F-20.1 & F-15.1: Skip->Active promotion, un-escalated Skip, and un-escalated Active preserve source",
    () =>
      Effect.gen(function* () {
        const skipInput = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
          diffSummary: ReviewSummaryText.make("Subtle invariant note"),
          changedLineCount: ReviewChangedLines.make(5),
          touchedTiers: [],
          touchedScopes: [],
        })

        // (a) depth-only escalation: recommendedDepth="lite", 0 probs
        const depthOnly = yield* routeReviewDiff(skipInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("lite"),
              needsSecurityProb: 0,
              needsReliabilityProb: 0,
              needsAdversarialProb: 0,
              needsMigrationContractProb: 0,
              needsArchitectureProb: 0,
            }),
          ),
        )
        expect(depthOnly._tag).toBe("ActiveReviewPlan")
        expect(depthOnly.depth).toBe("lite")
        expect(depthOnly.source).toBe("model-augmented")
        expect(depthOnly.selections[0]?.reviewer).toBe(ReviewerId.make("effect-ears-test-reviewer"))
        expect(depthOnly.selections[0]?.mandatory).toBe(false)

        // (b) probability-only escalation: recommendedDepth="skip", 2 probs >= 0.75 -> focused
        const prob2 = yield* routeReviewDiff(skipInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              needsReliabilityProb: 0.75,
              needsAdversarialProb: 0.8,
              needsSecurityProb: 0.1,
              needsMigrationContractProb: 0.1,
              needsArchitectureProb: 0.1,
            }),
          ),
        )
        expect(prob2._tag).toBe("ActiveReviewPlan")
        expect(prob2.depth).toBe("focused")
        expect(prob2.source).toBe("model-augmented")

        // (c) 3 probs >= 0.75 -> full
        const prob3 = yield* routeReviewDiff(skipInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              needsSecurityProb: 0.75,
              needsReliabilityProb: 0.75,
              needsAdversarialProb: 0.75,
              needsMigrationContractProb: 0.1,
              needsArchitectureProb: 0.1,
            }),
          ),
        )
        expect(prob3._tag).toBe("ActiveReviewPlan")
        expect(prob3.depth).toBe("full")
        expect(prob3.source).toBe("model-augmented")

        // (d) un-escalated Skip stays deterministic
        const staySkip = yield* routeReviewDiff(skipInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              needsSecurityProb: 0.74,
              needsReliabilityProb: 0.74,
              needsAdversarialProb: 0.74,
              needsMigrationContractProb: 0.74,
              needsArchitectureProb: 0.74,
            }),
          ),
        )
        expect(staySkip._tag).toBe("SkipReviewPlan")
        expect(staySkip.source).toBe("deterministic")

        // (e) un-escalated Active stays deterministic
        const focusedInput = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("libs/sample/auth/policy.ts")],
          diffSummary: ReviewSummaryText.make("Check token"),
          changedLineCount: ReviewChangedLines.make(10),
          touchedTiers: [],
          touchedScopes: [],
        })
        const stayFocused = yield* routeReviewDiff(focusedInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("lite"),
              needsSecurityProb: 0.74,
              needsReliabilityProb: 0.74,
              needsAdversarialProb: 0.74,
              needsMigrationContractProb: 0.74,
              needsArchitectureProb: 0.74,
            }),
          ),
        )
        expect(stayFocused._tag).toBe("ActiveReviewPlan")
        expect(stayFocused.depth).toBe("focused")
        expect(stayFocused.source).toBe("deterministic")
      }),
  )

  it.effect("F-20.1 & S-1.2: exact 0.74 vs 0.75 threshold across all 5 model lenses", () =>
    Effect.gen(function* () {
      const skipInput = ReviewRawDiffInput.make({
        changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
        diffSummary: ReviewSummaryText.make("Note"),
        changedLineCount: ReviewChangedLines.make(5),
        touchedTiers: [],
        touchedScopes: [],
      })

      const lensCases = [
        {
          key: "needsSecurityProb" as const,
          reviewer: ReviewerId.make("effect-security-reviewer"),
        },
        {
          key: "needsReliabilityProb" as const,
          reviewer: ReviewerId.make("effect-reliability-reviewer"),
        },
        {
          key: "needsAdversarialProb" as const,
          reviewer: ReviewerId.make("effect-adversarial-reviewer"),
        },
        {
          key: "needsMigrationContractProb" as const,
          reviewer: ReviewerId.make("effect-migration-contract-reviewer"),
        },
        {
          key: "needsArchitectureProb" as const,
          reviewer: ReviewerId.make("effect-architecture-reviewer"),
        },
      ]

      for (const lensCase of lensCases) {
        const below = yield* routeReviewDiff(skipInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              needsSecurityProb: 0,
              needsReliabilityProb: 0,
              needsAdversarialProb: 0,
              needsMigrationContractProb: 0,
              needsArchitectureProb: 0,
              [lensCase.key]: 0.74,
            }),
          ),
        )
        expect(below._tag).toBe("SkipReviewPlan")

        const atThreshold = yield* routeReviewDiff(skipInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("skip"),
              needsSecurityProb: 0,
              needsReliabilityProb: 0,
              needsAdversarialProb: 0,
              needsMigrationContractProb: 0,
              needsArchitectureProb: 0,
              [lensCase.key]: 0.75,
            }),
          ),
        )
        expect(atThreshold._tag).toBe("ActiveReviewPlan")
        expect(atThreshold.selections.map((s) => s.reviewer)).toEqual([lensCase.reviewer])
        expect(atThreshold.selections[0]?.mandatory).toBe(false)
      }
    }),
  )

  it.effect(
    "REQ-3.2 / F-9.1b: returns deterministic floor with degraded-fallback and degradedReason when DecisionModel fails",
    () =>
      Effect.gen(function* () {
        const input = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("libs/sample/contract/src/index.ts")],
          diffSummary: ReviewSummaryText.make("Update HttpApi endpoint"),
          changedLineCount: ReviewChangedLines.make(15),
          touchedTiers: [NxTierTag.make("type:contract")],
          touchedScopes: [],
        })

        const plan = yield* routeReviewDiff(input).pipe(
          Effect.provide(makeFailingDecisionModelLayer("Ollama down")),
        )

        expect(plan._tag).toBe("ActiveReviewPlan")
        expect(plan.source).toBe("degraded-fallback")
        expect(plan.degradedReason).toContain("Ollama down")
        expect(plan.selections.map((s) => s.reviewer)).toContain(
          ReviewerId.make("effect-migration-contract-reviewer"),
        )
      }),
  )

  it.effect(
    "F-7.1 / F-20.1: unknown recommendedDepth label returns degraded-fallback with degradedReason",
    () =>
      Effect.gen(function* () {
        const unknownLabelLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: () =>
              Effect.succeed({
                answers: {
                  recommendedDepth: {
                    _tag: "Classify",
                    label: "bogus-depth",
                    probabilities: {},
                  },
                  needsSecurityLens: { _tag: "Probability", probability: 0.1 },
                  needsReliabilityLens: { _tag: "Probability", probability: 0.1 },
                  needsAdversarialLens: { _tag: "Probability", probability: 0.1 },
                  needsMigrationContractLens: { _tag: "Probability", probability: 0.1 },
                  needsArchitectureLens: { _tag: "Probability", probability: 0.1 },
                },
                usage: {
                  inputTokens: 10,
                  outputTokens: 2,
                },
              }),
          }),
        )
        const input = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
          diffSummary: ReviewSummaryText.make("Note"),
          changedLineCount: ReviewChangedLines.make(5),
          touchedTiers: [],
          touchedScopes: [],
        })

        const plan = yield* routeReviewDiff(input).pipe(Effect.provide(unknownLabelLayer))
        expect(plan._tag).toBe("SkipReviewPlan")
        expect(plan.source).toBe("degraded-fallback")
        expect(plan.degradedReason).toContain("unknown label")
      }),
  )

  it.effect(
    "S-5.2 / F-9.1b: times out hanging DecisionModel at 1500ms (none at 1499ms) and supports custom timeoutMs",
    () =>
      Effect.gen(function* () {
        const hangingLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: () => Effect.never,
          }),
        )
        const input = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("libs/sample/contract/src/index.ts")],
          diffSummary: ReviewSummaryText.make("Update HttpApi endpoint"),
          changedLineCount: ReviewChangedLines.make(15),
          touchedTiers: [NxTierTag.make("type:contract")],
          touchedScopes: [],
        })

        const fiber = yield* routeReviewDiff(input).pipe(
          Effect.provide(hangingLayer),
          Effect.forkChild,
        )
        yield* TestClock.adjust("1499 millis")
        expect(fiber.pollUnsafe()).toBeUndefined()

        yield* TestClock.adjust("1 millis")
        const plan = yield* Fiber.join(fiber)

        expect(plan._tag).toBe("ActiveReviewPlan")
        expect(plan.source).toBe("degraded-fallback")
        expect(plan.degradedReason).toContain("1500ms")

        const customInput = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
          diffSummary: ReviewSummaryText.make("Note"),
          changedLineCount: ReviewChangedLines.make(5),
          touchedTiers: [],
          touchedScopes: [],
          timeoutMs: ReviewTimeoutMillis.make(500),
        })
        const customFiber = yield* routeReviewDiff(customInput).pipe(
          Effect.provide(hangingLayer),
          Effect.forkChild,
        )
        yield* TestClock.adjust("500 millis")
        const customPlan = yield* Fiber.join(customFiber)
        expect(customPlan.source).toBe("degraded-fallback")
        expect(customPlan.degradedReason).toContain("500ms")
      }),
  )

  it.effect(
    "F-10.1 / F-20.1: propagates Cause.die defects and pure fiber interruptions untouched",
    () =>
      Effect.gen(function* () {
        const defectLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: () => Effect.die(new Error("boom")),
          }),
        )
        const interruptingLayer = Layer.effect(
          DecisionModel.DecisionModel,
          DecisionModel.make({
            decide: () => Effect.interrupt,
          }),
        )
        const input = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("libs/sample/contract/src/index.ts")],
          diffSummary: ReviewSummaryText.make("Update"),
          changedLineCount: ReviewChangedLines.make(10),
          touchedTiers: [NxTierTag.make("type:contract")],
          touchedScopes: [],
        })

        const defectExit = yield* Effect.exit(
          routeReviewDiff(input).pipe(Effect.provide(defectLayer)),
        )
        expect(
          match(defectExit)
            .with({ _tag: "Failure" }, ({ cause }) => Cause.hasDies(cause))
            .with({ _tag: "Success" }, () => false)
            .exhaustive(),
        ).toBe(true)

        const interruptExit = yield* Effect.exit(
          routeReviewDiff(input).pipe(Effect.provide(interruptingLayer)),
        )
        expect(
          match(interruptExit)
            .with({ _tag: "Failure" }, ({ cause }) => Cause.hasInterrupts(cause))
            .with({ _tag: "Success" }, () => false)
            .exhaustive(),
        ).toBe(true)
      }),
  )

  it.effect(
    "SPEC-0030 REQ-1.1: omits slices below threshold (11) and partitions multi-package & oversized single-package diffs at >= 12",
    () =>
      Effect.gen(function* () {
        const belowFiles = Array.from({ length: 11 }, (_, i) =>
          ReviewRawFileInput.make(`libs/sample/domain/src/f-${i}.ts`),
        )
        const belowPlan = yield* routeReviewDiff(
          ReviewRawDiffInput.make({
            changedFiles: belowFiles,
            diffSummary: ReviewSummaryText.make("Below threshold"),
            changedLineCount: ReviewChangedLines.make(20),
            touchedTiers: [],
            touchedScopes: [],
          }),
        ).pipe(Effect.provide(makeMockDecisionModelLayer()))
        match(belowPlan)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            expect(active.reviewSlices).toBeUndefined()
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected ActiveReviewPlan below threshold")
          })
          .exhaustive()

        const mixedPaths = [
          "README.md",
          "libs/README.md",
          "docs/guide.md",
          "-leading-dash/item.ts",
          "@@/weird.ts",
          "tools/oxlint/syntax-bans.js",
          "adapters/claude-code/skills/a.md",
          "apps/harness-mcp/src/a.ts",
          "apps/sample-web/src/App.tsx",
          "libs/sample/contract/src/a.ts",
          "libs/sample/domain/src/b.ts",
          "libs/sample/infra/src/c.ts",
        ] as const
        const multiPlan = yield* routeReviewDiff(
          ReviewRawDiffInput.make({
            changedFiles: mixedPaths.map((p) => ReviewRawFileInput.make(p)),
            diffSummary: ReviewSummaryText.make("Multi-package change"),
            changedLineCount: ReviewChangedLines.make(60),
            touchedTiers: [],
            touchedScopes: [],
          }),
        ).pipe(Effect.provide(makeMockDecisionModelLayer({ needsSecurityProb: 0.9 })))

        match(multiPlan)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            expect(active.source).toBe("model-augmented")
            expect(active.reviewSlices).toBeDefined()
            const slices = active.reviewSlices!
            const sliceIds = slices.map((s) => s.sliceId)
            expect(sliceIds).toEqual([...sliceIds].sort(compareCodeUnits))
            expect(sliceIds).toContain("root")
            expect(sliceIds).toContain("libs/sample/contract")
            expect(sliceIds).toContain("apps/harness-mcp")
            expect(sliceIds).toContain("adapters/claude-code")
            expect(sliceIds).toContain("tools/oxlint")
            expect(sliceIds).toContain("leading-dash")
            expect(sliceIds).toContain("docs")
            const flattened = slices.flatMap((s) => s.files)
            expect(flattened).toHaveLength(mixedPaths.length)
            expect(new Set(flattened)).toEqual(new Set(mixedPaths))
            expect(slices.find((s) => s.sliceId === "root")?.files).toEqual([
              "@@/weird.ts",
              "README.md",
            ])
            expect(resolveReviewSliceUnitKey(ReviewSignalPath.make("libs/sample/README.md"))).toBe(
              "libs",
            )
            expect(
              resolveReviewSliceUnitKey(ReviewSignalPath.make("libs/sample/contract/package.json")),
            ).toBe("libs/sample/contract")
            expect(resolveReviewSliceUnitKey(ReviewSignalPath.make("apps/README.md"))).toBe("apps")
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected ActiveReviewPlan with reviewSlices")
          })
          .exhaustive()

        const exact180 = yield* inferReviewDiffSignals(
          ReviewRawDiffInput.make({
            changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
            diffSummary: ReviewSummaryText.make("Large prose guide"),
            changedLineCount: ReviewChangedLines.make(180),
            touchedTiers: [],
            touchedScopes: [],
          }),
        )
        expect(exact180.hasArchitectureOrAdapterSurface).toBe(true)
        const exact179 = yield* inferReviewDiffSignals(
          ReviewRawDiffInput.make({
            changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
            diffSummary: ReviewSummaryText.make("Large prose guide"),
            changedLineCount: ReviewChangedLines.make(179),
            touchedTiers: [],
            touchedScopes: [],
          }),
        )
        expect(exact179.hasArchitectureOrAdapterSurface).toBe(false)

        const singlePkgInput = ReviewRawDiffInput.make({
          changedFiles: Array.from({ length: 13 }, (_, i) =>
            ReviewRawFileInput.make(`libs/harness/gates/src/file-${String(i).padStart(2, "0")}.ts`),
          ),
          diffSummary: ReviewSummaryText.make("Large single pkg"),
          changedLineCount: ReviewChangedLines.make(200),
          touchedTiers: [NxTierTag.make("type:core")],
          touchedScopes: [],
        })
        const chunkedSignals = yield* inferReviewDiffSignals(singlePkgInput)
        const chunkedPlan = yield* decideDeterministicReviewRoute(chunkedSignals)
        match(chunkedPlan)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            expect(active.reviewSlices).toHaveLength(2)
            expect(active.reviewSlices?.[0]?.sliceId).toBe("libs/harness/gates#1")
            expect(active.reviewSlices?.[0]?.files).toHaveLength(REVIEW_SLICE_FILE_THRESHOLD)
            expect(active.reviewSlices?.[1]?.sliceId).toBe("libs/harness/gates#2")
            expect(active.reviewSlices?.[1]?.files).toHaveLength(1)
            expect(active.reviewSlices?.[0]?.label).toContain("part 1/2 (12 files)")
            expect(active.reviewSlices?.[1]?.label).toContain("part 2/2 (1 files)")
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected chunked ActiveReviewPlan")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "SPEC-0030 REQ-1.1 / REQ-1.2: attaches slices on Skip->Active promotion, degraded-fallback, and leaves existing slices untouched",
    () =>
      Effect.gen(function* () {
        const docPaths = Array.from({ length: 12 }, (_, i) =>
          ReviewRawFileInput.make(`docs/notes/note-${String(i).padStart(2, "0")}.md`),
        )
        const docInput = ReviewRawDiffInput.make({
          changedFiles: docPaths,
          diffSummary: ReviewSummaryText.make("Doc edits"),
          changedLineCount: ReviewChangedLines.make(12),
          touchedTiers: [],
          touchedScopes: [],
        })
        const docSignals = yield* inferReviewDiffSignals(docInput)
        const promoted = yield* routeReviewDiff(docInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("lite") }),
          ),
        )
        match(promoted)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            expect(active.source).toBe("model-augmented")
            expect(active.reviewSlices).toHaveLength(1)
            expect(active.reviewSlices?.[0]?.sliceId).toBe("docs")
            expect(active.reviewSlices?.[0]?.files).toHaveLength(12)
            expect(attachReviewSlicesIfThresholdReached(docSignals, active)).toBe(active)
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected model promotion to attach slices")
          })
          .exhaustive()

        const detSkip = yield* decideDeterministicReviewRoute(docSignals)
        expect(attachReviewSlicesIfThresholdReached(docSignals, detSkip)._tag).toBe(
          "SkipReviewPlan",
        )

        const largeCodeInput = ReviewRawDiffInput.make({
          changedFiles: Array.from({ length: 12 }, (_, i) =>
            ReviewRawFileInput.make(`libs/sample/domain/src/mod-${i}.ts`),
          ),
          diffSummary: ReviewSummaryText.make("Code change"),
          changedLineCount: ReviewChangedLines.make(50),
          touchedTiers: [],
          touchedScopes: [],
        })
        const degraded = yield* routeReviewDiff(largeCodeInput).pipe(
          Effect.provide(makeFailingDecisionModelLayer()),
        )
        match(degraded)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            expect(active.source).toBe("degraded-fallback")
            expect(active.reviewSlices).toHaveLength(1)
            expect(
              partitionDiffReviewSlices(docSignals, active, () => active.selections)?.length,
            ).toBe(1)
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected degraded ActiveReviewPlan")
          })
          .exhaustive()
        expect(resolveReviewSliceUnitKey(ReviewSignalPath.make("README.md"))).toBe("root")
      }),
  )

  it.effect.prop(
    "SPEC-0030 REQ-1.2 property: >= 12-file slices are disjoint, complete, sorted, order-invariant, and subset-preserving",
    {
      prefixCount: Schema.Int.check(Schema.isBetween({ minimum: 12, maximum: 18 })),
      reverseInput: Schema.Boolean,
    },
    ({ prefixCount, reverseInput }) =>
      Effect.gen(function* () {
        const universe = [
          "README.md",
          "libs/es/core/src/a.ts",
          "libs/es/core/src/b.ts",
          "libs/sample/contract/src/c.ts",
          "libs/sample/domain/src/d.ts",
          "libs/sample/domain/src/e.ts",
          "libs/sample/infra/migrations/0001_init.sql",
          "apps/sample-web/src/App.tsx",
          "apps/harness-mcp/src/f.ts",
          "adapters/claude-code/skills/g.md",
          "tools/oxlint/h.js",
          "docs/overview.md",
          "libs/harness/gates/src/i.ts",
          "libs/harness/gates/src/j.ts",
          "libs/harness/decision/src/k.ts",
          "libs/harness/graph/src/l.ts",
          "apps/harness-cli/src/m.ts",
          "CHANGELOG.md",
        ]
        const selected = universe.slice(0, prefixCount)
        const ordered = reverseInput ? [...selected].reverse() : selected
        const signalsA = yield* inferReviewDiffSignals(
          ReviewRawDiffInput.make({
            changedFiles: selected.map((p) => ReviewRawFileInput.make(p)),
            diffSummary: ReviewSummaryText.make("Prop slice invariance"),
            changedLineCount: ReviewChangedLines.make(80),
            touchedTiers: [],
            touchedScopes: [],
          }),
        )
        const signalsB = yield* inferReviewDiffSignals(
          ReviewRawDiffInput.make({
            changedFiles: ordered.map((p) => ReviewRawFileInput.make(p)),
            diffSummary: ReviewSummaryText.make("Prop slice invariance"),
            changedLineCount: ReviewChangedLines.make(80),
            touchedTiers: [],
            touchedScopes: [],
          }),
        )
        const planA = yield* decideDeterministicReviewRoute(signalsA)
        const planB = yield* decideDeterministicReviewRoute(signalsB)
        match([planA, planB] as const)
          .with([{ _tag: "ActiveReviewPlan" }, { _tag: "ActiveReviewPlan" }], ([a, b]) => {
            const slicesA = a.reviewSlices ?? []
            const slicesB = b.reviewSlices ?? []
            expect(slicesA.length).toBeGreaterThan(0)
            expect(slicesB.length).toBeGreaterThan(0)
            expect(slicesA.map((s) => s.sliceId)).toEqual(slicesB.map((s) => s.sliceId))
            expect(slicesA.map((s) => s.files)).toEqual(slicesB.map((s) => s.files))
            const allSliceFiles = slicesA.flatMap((s) => s.files)
            expect(allSliceFiles).toHaveLength(signalsA.changedFiles.length)
            expect(new Set(allSliceFiles)).toEqual(new Set(signalsA.changedFiles))
            const wholeReviewers = new Set(a.selections.map((s) => s.reviewer))
            for (const slice of slicesA) {
              for (const sel of slice.selections) {
                expect(wholeReviewers.has(sel.reviewer)).toBe(true)
              }
            }
          })
          .otherwise(() => {
            expect.unreachable("Expected ActiveReviewPlan on >= 12 files")
          })
      }),
  )

  it.effect(
    "SPEC-0030 REQ-3.1 / REQ-3.2: remediationContext prevents skip/lite downgrades for blocker|critical|major, preserves mandatory specialists, and allows minor skips",
    () =>
      Effect.gen(function* () {
        for (const sev of ["blocker", "critical", "major"] as const) {
          const remInput = ReviewRawDiffInput.make({
            changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
            diffSummary: ReviewSummaryText.make("Tiny remediation fix"),
            changedLineCount: ReviewChangedLines.make(5),
            touchedTiers: [],
            touchedScopes: [],
            remediationContext: RemediationReviewContext.make({
              priorSpecialists: [
                ReviewerId.make("effect-security-reviewer"),
                ReviewerId.make("effect-security-reviewer"),
                ReviewerId.make("effect-reliability-reviewer"),
              ],
              maxSeverity: RemediationFindingSeverity.make(sev),
            }),
          })

          const signals = yield* inferReviewDiffSignals(remInput)
          expect(signals.remediationContext?.priorSpecialists).toEqual([
            ReviewerId.make("effect-security-reviewer"),
            ReviewerId.make("effect-reliability-reviewer"),
          ])

          const floorPlan = yield* decideDeterministicReviewRoute(signals)
          expect(floorPlan._tag).toBe("ActiveReviewPlan")
          expect(getReviewDepthRank(floorPlan.depth)).toBeGreaterThanOrEqual(
            getReviewDepthRank(ReviewDepth.make("focused")),
          )
          const secSel = floorPlan.selections.find(
            (s) => s.reviewer === ReviewerId.make("effect-security-reviewer"),
          )
          const relSel = floorPlan.selections.find(
            (s) => s.reviewer === ReviewerId.make("effect-reliability-reviewer"),
          )
          expect(secSel?.mandatory).toBe(true)
          expect(relSel?.mandatory).toBe(true)

          const modelRouted = yield* routeReviewDiff(remInput, signals).pipe(
            Effect.provide(
              makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") }),
            ),
          )
          expect(getReviewDepthRank(modelRouted.depth)).toBeGreaterThanOrEqual(
            getReviewDepthRank(ReviewDepth.make("focused")),
          )
          expect(
            modelRouted.selections.some(
              (s) => s.reviewer === ReviewerId.make("effect-security-reviewer") && s.mandatory,
            ),
          ).toBe(true)
        }

        const minorInput = ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
          diffSummary: ReviewSummaryText.make("Minor typo"),
          changedLineCount: ReviewChangedLines.make(3),
          touchedTiers: [],
          touchedScopes: [],
          remediationContext: RemediationReviewContext.make({
            priorSpecialists: [ReviewerId.make("effect-architecture-reviewer")],
            maxSeverity: RemediationFindingSeverity.make("minor"),
          }),
        })
        const minorPlan = yield* routeReviewDiff(minorInput).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({ reviewDepthLabel: ReviewDepth.make("skip") }),
          ),
        )
        expect(minorPlan._tag).toBe("SkipReviewPlan")
        expect(minorPlan.depth).toBe("skip")
      }),
  )
})
