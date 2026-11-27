import { Cause, Effect, Fiber, Layer, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "@effect/vitest"
import {
  NxScopeTag,
  NxTierTag,
  REVIEW_SLICE_FILE_THRESHOLD,
  RemediationFindingSeverity,
  RemediationReviewContext,
  ReviewChangedLines,
  ReviewDepth,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewSignalPath,
  ReviewSliceId,
  ReviewSummaryText,
  ReviewTimeoutMillis,
  ReviewerId,
  compareCodeUnits,
  getReviewDepthRank,
} from "@harness/contract"
import { match } from "ts-pattern"
import { makeFailingDecisionModelLayer, makeMockDecisionModelLayer } from "../src/mock-layer.js"
import {
  attachReviewSlicesIfThresholdReached,
  computeFilePathSurfaceFlags,
  decideDeterministicReviewRoute,
  inferReviewDiffSignals,
  reconcileReviewSlicesWithSelections,
  routeReviewDiff,
} from "../src/review-router-decision.js"
import {
  partitionDiffReviewSlices,
  resolveReviewSliceUnitKey,
} from "../src/review-slice-partitioner.js"

describe("ReviewRouterV1 slice partitioner, fallback & properties", () => {
  it.effect(
    "S-5.2 / F-9.1b: times out hanging DecisionModel at 5000ms (none at 4999ms) and supports custom timeoutMs",
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
        yield* TestClock.adjust("4999 millis")
        expect(fiber.pollUnsafe()).toBeUndefined()

        yield* TestClock.adjust("1 millis")
        const plan = yield* Fiber.join(fiber)

        expect(plan._tag).toBe("ActiveReviewPlan")
        expect(plan.source).toBe("degraded-fallback")
        expect(plan.degradedReason).toContain("5000ms")

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
            const leadingDashId = resolveReviewSliceUnitKey(
              ReviewSignalPath.make("-leading-dash/item.ts"),
            )
            const weirdId = resolveReviewSliceUnitKey(ReviewSignalPath.make("@@/weird.ts"))
            expect(leadingDashId).toMatch(/^leading-dash-[0-9a-f]{8}$/)
            expect(weirdId).toMatch(/^root-[0-9a-f]{8}$/)
            expect(sliceIds).toContain(leadingDashId)
            expect(sliceIds).toContain(weirdId)
            expect(sliceIds).toContain("docs")
            const flattened = slices.flatMap((s) => s.files)
            expect(flattened).toHaveLength(mixedPaths.length)
            expect(new Set(flattened)).toEqual(new Set(mixedPaths))
            expect(slices.find((s) => s.sliceId === "root")?.files).toEqual(["README.md"])
            expect(slices.find((s) => s.sliceId === weirdId)?.files).toEqual(["@@/weird.ts"])
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
      prefixCount: Schema.Int.check(Schema.isBetween({ minimum: 12, maximum: 22 })),
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
          ".github/workflows/ci.yml",
          ".vscode/settings.json",
          "_scripts/check.ts",
          "._:/weird.ts",
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

  it.effect(
    "F-01 & F-02: handles dot/underscore/colon slice roots safely, detects libs/*/service, and preserves whole-plan specialist union in reviewSlices",
    () =>
      Effect.gen(function* () {
        const dotAndServiceFiles = [
          ".github/workflows/ci.yml",
          "github/workflows/mirror.yml",
          ".vscode/settings.json",
          "_scripts/check.ts",
          "scripts/check.ts",
          "._:/weird.ts",
          "libs/sample/service/src/port.ts",
          "libs/sample/domain/src/a.ts",
          "libs/sample/domain/src/b.ts",
          "libs/sample/domain/src/c.ts",
          "libs/sample/domain/src/d.ts",
          "libs/sample/domain/src/e.ts",
        ].map((p) => ReviewRawFileInput.make(p))

        const augmented = yield* routeReviewDiff(
          ReviewRawDiffInput.make({
            changedFiles: dotAndServiceFiles,
            diffSummary: ReviewSummaryText.make("Update oauth pipeline"),
            changedLineCount: ReviewChangedLines.make(190),
            touchedTiers: [NxTierTag.make("type:contract")],
            touchedScopes: [NxScopeTag.make("scope:web")],
          }),
        ).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("full"),
              needsReliabilityProb: 0.9,
            }),
          ),
        )

        match(augmented)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            expect(active.reviewSlices?.length ?? 0).toBeGreaterThan(0)
            const slices = active.reviewSlices!
            const sliceIds = slices.map((s) => s.sliceId)
            for (const id of sliceIds) {
              expect(Schema.is(ReviewSliceId)(id)).toBe(true)
            }
            const dotGithubId = resolveReviewSliceUnitKey(
              ReviewSignalPath.make(".github/workflows/ci.yml"),
            )
            const underscoreScriptsId = resolveReviewSliceUnitKey(
              ReviewSignalPath.make("_scripts/check.ts"),
            )
            const dotColonId = resolveReviewSliceUnitKey(ReviewSignalPath.make("._:/weird.ts"))
            expect(dotGithubId).toMatch(/^s-\.github-[0-9a-f]{8}$/)
            expect(underscoreScriptsId).toMatch(/^s-_scripts-[0-9a-f]{8}$/)
            expect(dotColonId).toMatch(/^s-\._:-[0-9a-f]{8}$/)
            expect(sliceIds).toContain(dotGithubId)
            expect(sliceIds).toContain("github")
            expect(sliceIds).toContain(underscoreScriptsId)
            expect(sliceIds).toContain("scripts")
            expect(sliceIds).toContain(dotColonId)

            const wholeReviewers = new Set(active.selections.map((s) => s.reviewer))
            expect(wholeReviewers.has(ReviewerId.make("effect-architecture-reviewer"))).toBe(true)
            expect(wholeReviewers.has(ReviewerId.make("effect-security-reviewer"))).toBe(true)
            expect(wholeReviewers.has(ReviewerId.make("effect-web-reviewer"))).toBe(true)
            expect(wholeReviewers.has(ReviewerId.make("effect-migration-contract-reviewer"))).toBe(
              true,
            )
            expect(wholeReviewers.has(ReviewerId.make("effect-reliability-reviewer"))).toBe(true)

            const sliceUnion = new Set(
              slices.flatMap((s) => s.selections.map((sel) => sel.reviewer)),
            )
            expect(sliceUnion).toEqual(wholeReviewers)

            const serviceOnlySignals = computeFilePathSurfaceFlags(
              [ReviewSignalPath.make("libs/sample/service/src/port.ts")],
              new Set(),
              new Set(),
              ReviewSummaryText.make(""),
              ReviewChangedLines.make(0),
            ).hasArchitectureOrAdapterSurface
            expect(serviceOnlySignals).toBe(true)
            expect(reconcileReviewSlicesWithSelections(slices, active.selections)).toBe(slices)
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected ActiveReviewPlan")
          })
          .exhaustive()

        const promotedDocPlan = yield* routeReviewDiff(
          ReviewRawDiffInput.make({
            changedFiles: Array.from({ length: 12 }, (_, i) =>
              ReviewRawFileInput.make(`docs/guide/page-${i}.md`),
            ),
            diffSummary: ReviewSummaryText.make("Doc sweep"),
            changedLineCount: ReviewChangedLines.make(10),
            touchedTiers: [],
            touchedScopes: [],
          }),
        ).pipe(
          Effect.provide(
            makeMockDecisionModelLayer({
              reviewDepthLabel: ReviewDepth.make("focused"),
              needsSecurityProb: 0.9,
              needsReliabilityProb: 0.9,
            }),
          ),
        )
        match(promotedDocPlan)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            const wholeUnion = new Set(active.selections.map((s) => s.reviewer))
            const sliceUnion = new Set(
              (active.reviewSlices ?? []).flatMap((s) => s.selections.map((sel) => sel.reviewer)),
            )
            expect(sliceUnion).toEqual(wholeUnion)
            expect(wholeUnion.size).toBe(2)
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected Skip->Active promotion")
          })
          .exhaustive()
      }),
  )

  it.effect(
    "F-14.2 / SPEC-0030 REQ-1.2: collision-resistant slice IDs separate .github vs s-.github, foo@bar vs foo-bar, and >112-char shared prefixes without throwing",
    () =>
      Effect.gen(function* () {
        const shared115 = "p".repeat(115)
        const exact112 = "k".repeat(112)
        const over112 = "k".repeat(113)
        const longPrefixA = `${shared115}-alpha`
        const longPrefixB = `${shared115}-beta`
        const longChunkRoot = `libs/sample/${"q".repeat(115)}-gamma`

        expect(resolveReviewSliceUnitKey(ReviewSignalPath.make(`${exact112}/a.ts`))).toBe(exact112)
        const over112Key = resolveReviewSliceUnitKey(ReviewSignalPath.make(`${over112}/a.ts`))
        expect(over112Key).toHaveLength(112)
        expect(over112Key).toMatch(/^k{103}-[0-9a-f]{8}$/)

        const collisionFiles = [
          ".github/workflows/ci.yml",
          "s-.github/workflows/ci.yml",
          "foo@bar/a.ts",
          "foo-bar/a.ts",
          `${longPrefixA}/a.ts`,
          `${longPrefixB}/b.ts`,
          ...Array.from(
            { length: 13 },
            (_, idx) => `${longChunkRoot}/file-${String(idx).padStart(2, "0")}.ts`,
          ),
        ]

        const routed = yield* routeReviewDiff(
          ReviewRawDiffInput.make({
            changedFiles: collisionFiles.map((p) => ReviewRawFileInput.make(p)),
            diffSummary: ReviewSummaryText.make("Collision and long-root slice test"),
            changedLineCount: ReviewChangedLines.make(50),
            touchedTiers: [],
            touchedScopes: [],
          }),
        ).pipe(Effect.provide(makeMockDecisionModelLayer()))

        match(routed)
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            const slices = active.reviewSlices ?? []
            expect(slices.length).toBe(8)
            const sliceIds = slices.map((s) => s.sliceId)
            expect(new Set(sliceIds).size).toBe(slices.length)
            for (const slice of slices) {
              expect(Schema.is(ReviewSliceId)(slice.sliceId)).toBe(true)
              expect(slice.sliceId.length).toBeLessThanOrEqual(128)
            }

            const dotGithubSlice = slices.find((s) => s.files[0] === ".github/workflows/ci.yml")
            const literalSGithubSlice = slices.find(
              (s) => s.files[0] === "s-.github/workflows/ci.yml",
            )
            expect(dotGithubSlice?.sliceId).toMatch(/^s-\.github-[0-9a-f]{8}$/)
            expect(literalSGithubSlice?.sliceId).toBe("s-.github")
            expect(dotGithubSlice?.sliceId).not.toBe(literalSGithubSlice?.sliceId)

            const atSlice = slices.find((s) => s.files[0] === "foo@bar/a.ts")
            const dashSlice = slices.find((s) => s.files[0] === "foo-bar/a.ts")
            expect(atSlice?.sliceId).toMatch(/^foo-bar-[0-9a-f]{8}$/)
            expect(dashSlice?.sliceId).toBe("foo-bar")
            expect(atSlice?.sliceId).not.toBe(dashSlice?.sliceId)

            const longSliceA = slices.find((s) => s.files[0] === `${longPrefixA}/a.ts`)
            const longSliceB = slices.find((s) => s.files[0] === `${longPrefixB}/b.ts`)
            expect(longSliceA?.sliceId).toHaveLength(112)
            expect(longSliceB?.sliceId).toHaveLength(112)
            expect(longSliceA?.sliceId).not.toBe(longSliceB?.sliceId)

            const chunkedSlices = slices.filter((s) =>
              s.files.some((f) => f.startsWith(`${longChunkRoot}/`)),
            )
            expect(chunkedSlices).toHaveLength(2)
            expect(chunkedSlices[0]?.sliceId).toMatch(/#1$/)
            expect(chunkedSlices[1]?.sliceId).toMatch(/#2$/)
            expect(chunkedSlices[0]?.sliceId.length).toBeLessThanOrEqual(115)

            const flattened = slices.flatMap((s) => s.files)
            expect(new Set(flattened)).toEqual(new Set(collisionFiles))
          })
          .with({ _tag: "SkipReviewPlan" }, () => {
            expect.unreachable("Expected ActiveReviewPlan for collision diff")
          })
          .exhaustive()
      }),
  )
})
