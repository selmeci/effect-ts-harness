import { Cause, Effect, Fiber, Layer, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "@effect/vitest"
import {
  NxScopeTag,
  NxTierTag,
  ReviewChangedLines,
  ReviewDepth,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewSummaryText,
  ReviewerId,
} from "@harness/contract"
import { match } from "ts-pattern"
import { validateDecisionLimits } from "../src/idiom-router.js"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "../src/mock-layer.js"
import {
  ReviewRouterV1,
  decideDeterministicReviewRoute,
  inferReviewDiffSignals,
  routeReviewDiff,
} from "../src/review-router-decision.js"

const getDepthRank = (depth: ReviewDepth): number =>
  match<string, number>(depth)
    .with("skip", () => 0)
    .with("lite", () => 1)
    .with("focused", () => 2)
    .with("full", () => 3)
    .otherwise(() => 0)

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

const DiffSummaryArb = Schema.Literals([
  "",
  "AtomHttpApi",
  "Redacted auth token",
  "SqliteMigrator",
])

const BoundaryProbArb = Schema.Literals([0, 0.74, 0.75, 1])

const ReviewPropInputArb = Schema.Struct({
  files: Schema.Array(SafeRelativePathArb),
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

describe("ReviewRouterV1 and monotonic hybrid review routing", () => {
  it.effect("validates ReviewRouterV1 against Ollama System One limits", () =>
    validateDecisionLimits(ReviewRouterV1),
  )

  it.effect("REQ-1.1: normalizes paths, deduplicates, and infers surface flags", () =>
    Effect.gen(function* () {
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
      expect(signals.hasTestOrSpecChange).toBe(true)
    }),
  )

  it.effect("REQ-1.2: rejects empty, null-byte, absolute, drive, and evasion paths with InvalidReviewRouteInputError", () =>
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

  it.effect("REQ-2.1 & REQ-2.2: returns SkipReviewPlan for empty diff or trivial docs < 40 lines, and promotes at 40 lines", () =>
    Effect.gen(function* () {
      const emptySignals = yield* inferReviewDiffSignals(
        ReviewRawDiffInput.make({
          changedFiles: [],
          diffSummary: ReviewSummaryText.make(""),
          changedLineCount: ReviewChangedLines.make(0),
          touchedTiers: [],
          touchedScopes: [],
        }),
      )
      const emptyPlan = yield* decideDeterministicReviewRoute(emptySignals)
      expect(emptyPlan._tag).toBe("SkipReviewPlan")
      expect(emptyPlan.depth).toBe("skip")
      expect(emptyPlan.selections).toEqual([])

      const doc39Signals = yield* inferReviewDiffSignals(
        ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("docs/changelog.md")],
          diffSummary: ReviewSummaryText.make("Fix typo in changelog"),
          changedLineCount: ReviewChangedLines.make(39),
          touchedTiers: [],
          touchedScopes: [],
        }),
      )
      const doc39Plan = yield* decideDeterministicReviewRoute(doc39Signals)
      expect(doc39Plan._tag).toBe("SkipReviewPlan")
      expect(doc39Plan.depth).toBe("skip")

      const doc40Signals = yield* inferReviewDiffSignals(
        ReviewRawDiffInput.make({
          changedFiles: [ReviewRawFileInput.make("docs/changelog.md")],
          diffSummary: ReviewSummaryText.make("Large doc rewrite"),
          changedLineCount: ReviewChangedLines.make(40),
          touchedTiers: [],
          touchedScopes: [],
        }),
      )
      const doc40Plan = yield* decideDeterministicReviewRoute(doc40Signals)
      expect(doc40Plan._tag).toBe("ActiveReviewPlan")
      expect(doc40Plan.depth).toBe("focused")
      expect(doc40Plan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-architecture-reviewer"),
      )
    }),
  )

  it.effect("REQ-2.3: routes all 7 specialist lenses, lite depth (<40 lines, 1 selection), and 179 vs 180 boundary", () =>
    Effect.gen(function* () {
      const routeOnly = (
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

      // 1. lite depth: 1 selection, < 40 lines (e.g. EARS spec only)
      const litePlan = yield* routeOnly(
        ["libs/sample/docs/specs/2026-11-17-feature.md"],
        "Add EARS spec",
        25,
      )
      expect(litePlan._tag).toBe("ActiveReviewPlan")
      expect(litePlan.depth).toBe("lite")
      expect(litePlan.selections.map((s) => s.reviewer)).toEqual([
        ReviewerId.make("effect-ears-test-reviewer"),
      ])

      // 2. Dual-review invariant for stateful/decider changes
      const deciderPlan = yield* routeOnly(
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
      expect(deciderPlan.depth).toBe("focused")

      // 3. Security lens
      const secPlan = yield* routeOnly(["libs/sample/auth/policy.ts"], "Check token", 10)
      expect(secPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-security-reviewer"),
      )

      // 4. Reliability lens
      const relPlan = yield* routeOnly(
        ["libs/sample/infra/src/repo.ts"],
        "Use Scope",
        10,
        [NxTierTag.make("type:infra")],
      )
      expect(relPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-reliability-reviewer"),
      )

      // 5. Web lens
      const webPlan = yield* routeOnly(
        ["apps/sample-web/src/App.tsx"],
        "Update AtomHttpApi",
        10,
        [],
        [NxScopeTag.make("scope:web")],
      )
      expect(webPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-web-reviewer"),
      )

      // 6. Migration & contract lens (always full when migration touched)
      const migPlan = yield* routeOnly(
        ["libs/sample/infra/migrations/0002_idx.sql"],
        "Add index",
        10,
      )
      expect(migPlan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-migration-contract-reviewer"),
      )
      expect(migPlan.depth).toBe("full")

      // 7. Architecture lens + 179 vs 180 boundary
      const plan179 = yield* routeOnly(["libs/sample/service/src/ports.ts"], "Update port", 179, [
        NxTierTag.make("type:service"),
      ])
      expect(plan179.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-architecture-reviewer"),
      )
      expect(plan179.depth).toBe("focused")

      const plan180 = yield* routeOnly(["libs/sample/service/src/ports.ts"], "Update port", 180, [
        NxTierTag.make("type:service"),
      ])
      expect(plan180.depth).toBe("full")
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

        const routedPlan = yield* routeReviewDiff(input).pipe(Effect.provide(mockLayer))

        expect(getDepthRank(routedPlan.depth)).toBeGreaterThanOrEqual(
          getDepthRank(floorPlan.depth),
        )
        const routedReviewerIds = new Set(routedPlan.selections.map((s) => s.reviewer))
        for (const floorSel of floorPlan.selections) {
          expect(routedReviewerIds.has(floorSel.reviewer)).toBe(true)
        }
      }),
  )

  it.effect("REQ-3.1: promotes SkipReviewPlan to ActiveReviewPlan when System One escalates", () =>
    Effect.gen(function* () {
      const input = ReviewRawDiffInput.make({
        changedFiles: [ReviewRawFileInput.make("docs/notes.md")],
        diffSummary: ReviewSummaryText.make("Subtle invariant note"),
        changedLineCount: ReviewChangedLines.make(5),
        touchedTiers: [],
        touchedScopes: [],
      })

      const plan = yield* routeReviewDiff(input).pipe(
        Effect.provide(
          makeMockDecisionModelLayer({
            reviewDepthLabel: ReviewDepth.make("focused"),
            needsAdversarialProb: 0.9,
          }),
        ),
      )

      expect(plan._tag).toBe("ActiveReviewPlan")
      expect(plan.depth).toBe("focused")
      expect(plan.source).toBe("model-augmented")
      expect(plan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-adversarial-reviewer"),
      )
    }),
  )

  it.effect("REQ-3.2: returns deterministic floor with degraded-fallback when DecisionModel fails", () =>
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
      expect(plan.selections.map((s) => s.reviewer)).toContain(
        ReviewerId.make("effect-migration-contract-reviewer"),
      )
    }),
  )

  it.effect("REQ-3.2: times out hanging DecisionModel at 1500 millis and returns degraded-fallback", () =>
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
      yield* TestClock.adjust("1500 millis")
      const plan = yield* Fiber.join(fiber)

      expect(plan._tag).toBe("ActiveReviewPlan")
      expect(plan.source).toBe("degraded-fallback")
    }),
  )

  it.effect("propagates pure fiber interruption from DecisionModel without swallowing", () =>
    Effect.gen(function* () {
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

      const exit = yield* Effect.exit(routeReviewDiff(input).pipe(Effect.provide(interruptingLayer)))
      expect(
        match(exit)
          .with({ _tag: "Failure" }, ({ cause }) => Cause.hasInterrupts(cause))
          .with({ _tag: "Success" }, () => false)
          .exhaustive(),
      ).toBe(true)
    }),
  )
})
