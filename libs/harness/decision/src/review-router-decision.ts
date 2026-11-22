import { Effect, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import type * as DecisionModelTag from "effect/ai/DecisionModel"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  ActiveReviewPlan,
  DEFAULT_REVIEW_ROUTE_TIMEOUT_MS,
  ErrorReasonMessage,
  InvalidReviewRouteInputError,
  REVIEW_DEPTH_RANK,
  ReviewChangedLines,
  ReviewDepth,
  type ReviewDepthRank,
  type ReviewDiffSignals,
  type ReviewRawDiffInput,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  ReviewerId,
  ReviewerSelection,
  SkipReviewPlan,
  getReviewDepthRank,
  toErrorReasonMessage,
} from "@harness/contract"
import { match } from "ts-pattern"
import {
  attachReviewSlicesIfThresholdReached,
  collectSurfaceSelections,
  computeFilePathSurfaceFlags,
  inferReviewDiffSignals,
  isEscalatingRemediationSeverity,
  isNonGovernanceDocPath,
  normalizeReviewFilePaths,
  reconcileReviewSlicesWithSelections,
} from "./review-signal-inference.js"

export {
  attachReviewSlicesIfThresholdReached,
  computeFilePathSurfaceFlags,
  inferReviewDiffSignals,
  normalizeReviewFilePaths,
  reconcileReviewSlicesWithSelections,
}

/** Versioned System One decision definition for monotonic review depth & specialist lens routing. */
export const ReviewRouterV1 = Decision.make({
  input: Schema.Struct({
    changedFiles: Schema.String,
    diffSummary: Schema.String,
    changedLineCount: ReviewChangedLines,
    touchedTiers: Schema.String,
  }),
  decisions: {
    recommendedDepth: Decision.classify({
      instructions:
        "Classify the required code review depth for this diff from least to most thorough.",
      criteria: {
        skip: "Trivial formatting, comment-only, or doc-only change with zero behavioral risk",
        lite: "Small, localized single-tier change with low blast radius",
        focused: "Multi-file or cross-boundary change requiring targeted specialist lenses",
        full: "High-risk, multi-tier, stateful, security, migration, or architectural change",
      },
    }),
    needsSecurityLens: Decision.probability({
      instructions:
        "Does this diff touch auth, trust boundaries, secrets, path validation, or untrusted input?",
    }),
    needsReliabilityLens: Decision.probability({
      instructions:
        "Does this diff touch concurrency, fibers, Scope/resources, retries, or error/cause handling?",
    }),
    needsAdversarialLens: Decision.probability({
      instructions:
        "Does this diff introduce or alter complex state transitions, deciders, or boundary invariants?",
    }),
    needsMigrationContractLens: Decision.probability({
      instructions:
        "Does this diff alter SQL migrations, persisted schemas, HttpApi/RpcGroup contracts, or Alchemy bindings?",
    }),
    needsArchitectureLens: Decision.probability({
      instructions:
        "Does this diff alter package boundaries, Context.Service ports, Layers, or agent/adapter surfaces?",
    }),
  },
})

const LENS_CONFIDENCE_THRESHOLD = 0.75

type ActiveRank = 1 | 2 | 3

const activeDepthFromRank = (rank: ActiveRank): ActiveReviewPlan["depth"] =>
  match(rank)
    .with(1, () => ReviewDepth.make("lite"))
    .with(2, () => ReviewDepth.make("focused"))
    .with(3, () => ReviewDepth.make("full"))
    .exhaustive()

const toActiveRank = (rank: number | ReviewDepthRank): ActiveRank => {
  if (rank >= REVIEW_DEPTH_RANK.full) {
    return 3
  }
  if (rank >= REVIEW_DEPTH_RANK.focused) {
    return 2
  }
  return 1
}

export const decideDeterministicReviewRoute = Effect.fn("ReviewRouter.decideDeterministic")(
  function* (signals: ReviewDiffSignals): Effect.fn.Return<ReviewRoutingPlan> {
    return yield* Effect.sync(() => {
      const noSurfaceFlags =
        !signals.hasTestOrSpecChange &&
        !signals.hasContractBoundaryChange &&
        !signals.hasMigrationOrInfraBindingChange &&
        !signals.hasStatefulOrDeciderChange &&
        !signals.hasConcurrencyOrResourceChange &&
        !signals.hasAuthOrSecretSurface &&
        !signals.hasArchitectureOrAdapterSurface &&
        !signals.hasWebSurface

      const requiresRemediationAudit =
        signals.remediationContext !== undefined &&
        isEscalatingRemediationSeverity(signals.remediationContext.maxSeverity)

      if (
        !requiresRemediationAudit &&
        signals.changedFiles.every(isNonGovernanceDocPath) &&
        noSurfaceFlags &&
        signals.changedLineCount < 40
      ) {
        return SkipReviewPlan.make({
          depth: ReviewDepth.make("skip"),
          source: ReviewRoutingSource.make("deterministic"),
          reason: ReviewRoutingReason.make("Trivial non-code documentation edit under 40 lines"),
          selections: [],
        })
      }

      const selections = collectSurfaceSelections(signals, signals.remediationContext)

      const [firstSelection, ...restSelections] = selections
      const hasTypeScriptFile = signals.changedFiles.some(
        (p) => p.endsWith(".ts") || p.endsWith(".tsx"),
      )
      const fallbackSelection = hasTypeScriptFile
        ? ReviewerSelection.make({
            reviewer: ReviewerId.make("effect-ears-test-reviewer"),
            reason: ReviewRoutingReason.make(
              "TypeScript change requires EARS and test coverage review",
            ),
            mandatory: true,
          })
        : ReviewerSelection.make({
            reviewer: ReviewerId.make("effect-architecture-reviewer"),
            reason: ReviewRoutingReason.make(
              signals.changedLineCount >= 40
                ? "Non-trivial change (>=40 lines) requires review"
                : "Non-documentation file change requires review",
            ),
            mandatory: true,
          })

      const nonEmptySelections: readonly [ReviewerSelection, ...Array<ReviewerSelection>] =
        firstSelection !== undefined ? [firstSelection, ...restSelections] : [fallbackSelection]

      const isFull =
        signals.hasStatefulOrDeciderChange ||
        signals.hasMigrationOrInfraBindingChange ||
        signals.touchedTiers.length >= 2 ||
        nonEmptySelections.length >= 3 ||
        signals.changedLineCount >= 180

      const isFocused =
        !isFull &&
        (requiresRemediationAudit ||
          signals.changedFiles.length > 1 ||
          signals.changedLineCount >= 40 ||
          nonEmptySelections.length >= 2 ||
          signals.hasAuthOrSecretSurface ||
          signals.hasContractBoundaryChange)

      const depth = isFull
        ? ReviewDepth.make("full")
        : isFocused
          ? ReviewDepth.make("focused")
          : ReviewDepth.make("lite")

      const basePlan = ActiveReviewPlan.make({
        depth,
        source: ReviewRoutingSource.make("deterministic"),
        selections: nonEmptySelections,
      })
      return attachReviewSlicesIfThresholdReached(signals, basePlan)
    })
  },
)

const withDegradedFallback = (
  plan: ReviewRoutingPlan,
  degradedReason: ErrorReasonMessage,
): ReviewRoutingPlan =>
  match(plan)
    .with({ _tag: "SkipReviewPlan" }, (skip) =>
      SkipReviewPlan.make({
        ...skip,
        source: ReviewRoutingSource.make("degraded-fallback"),
        degradedReason,
      }),
    )
    .with({ _tag: "ActiveReviewPlan" }, (active) =>
      ActiveReviewPlan.make({
        ...active,
        source: ReviewRoutingSource.make("degraded-fallback"),
        degradedReason,
      }),
    )
    .exhaustive()

const deriveSelectionsImpliedRank = (selections: ReadonlyArray<ReviewerSelection>): number => {
  if (selections.length >= 3) {
    return 3
  }
  if (
    selections.length === 2 ||
    selections.some((s) => s.reviewer === ReviewerId.make("effect-security-reviewer"))
  ) {
    return 2
  }
  if (selections.length === 1) {
    return 1
  }
  return 0
}

export const routeReviewDiff = Effect.fn("Harness.routeReviewDiff")(function* (
  input: ReviewRawDiffInput,
  precomputedSignals?: ReviewDiffSignals,
): Effect.fn.Return<
  ReviewRoutingPlan,
  InvalidReviewRouteInputError,
  DecisionModelTag.DecisionModel
> {
  const signals =
    precomputedSignals !== undefined ? precomputedSignals : yield* inferReviewDiffSignals(input)
  const floorPlan = yield* decideDeterministicReviewRoute(signals)

  const timeoutMs = input.timeoutMs ?? DEFAULT_REVIEW_ROUTE_TIMEOUT_MS

  const outcome = yield* DecisionModel.decide(ReviewRouterV1, {
    input: {
      changedFiles: signals.changedFiles.join(", "),
      diffSummary: signals.diffSummary,
      changedLineCount: signals.changedLineCount,
      touchedTiers: signals.touchedTiers.join(", "),
    },
  }).pipe(
    Effect.timeoutOption(`${timeoutMs} millis`),
    Effect.map((opt) =>
      match(opt)
        .with({ _tag: "Some" }, ({ value }) => ({ _tag: "Decided" as const, value }))
        .with({ _tag: "None" }, () => ({ _tag: "TimedOut" as const }))
        .exhaustive(),
    ),
    Effect.catch((error) =>
      Effect.succeed({
        _tag: "Failed" as const,
        reason: toErrorReasonMessage(error),
      }),
    ),
  )

  return yield* match(outcome)
    .with({ _tag: "TimedOut" }, () =>
      Effect.gen(function* () {
        const reason = toErrorReasonMessage(
          `ReviewRouter DecisionModel timed out after ${timeoutMs}ms`,
        )
        yield* Effect.logWarning(reason)
        yield* Effect.annotateCurrentSpan("review.router.degradedReason", reason)
        return withDegradedFallback(floorPlan, reason)
      }),
    )
    .with({ _tag: "Failed" }, ({ reason }) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(`ReviewRouter DecisionModel failed: ${reason}`)
        yield* Effect.annotateCurrentSpan("review.router.degradedReason", reason)
        return withDegradedFallback(floorPlan, reason)
      }),
    )
    .with({ _tag: "Decided" }, ({ value }) =>
      Effect.gen(function* () {
        const { answers } = value
        const decodedDepth = Schema.decodeUnknownOption(ReviewDepth)(
          answers.recommendedDepth.label as unknown,
        )

        return yield* match(decodedDepth)
          .with({ _tag: "None" }, () =>
            Effect.gen(function* () {
              const reason = toErrorReasonMessage(
                `Unknown ReviewRouter recommendedDepth label: ${answers.recommendedDepth.label}`,
              )
              yield* Effect.logWarning(reason)
              yield* Effect.annotateCurrentSpan("review.router.degradedReason", reason)
              return withDegradedFallback(floorPlan, reason)
            }),
          )
          .with({ _tag: "Some" }, ({ value: modelDepth }) =>
            Effect.sync(() => {
              const floorRank = getReviewDepthRank(floorPlan.depth)
              const modelRank = getReviewDepthRank(modelDepth)

              const modelExtraSelections: Array<ReviewerSelection> = []
              const floorReviewers = new Set<ReviewerId>(
                floorPlan.selections.map((sel) => sel.reviewer),
              )

              const appendOptionalIfHigh = (
                prob: number,
                reviewer: ReviewerId,
                reason: string,
              ): void => {
                if (prob >= LENS_CONFIDENCE_THRESHOLD && !floorReviewers.has(reviewer)) {
                  floorReviewers.add(reviewer)
                  modelExtraSelections.push(
                    ReviewerSelection.make({
                      reviewer,
                      reason: ReviewRoutingReason.make(reason),
                      mandatory: false,
                    }),
                  )
                }
              }

              appendOptionalIfHigh(
                answers.needsSecurityLens.probability,
                ReviewerId.make("effect-security-reviewer"),
                "System One flagged elevated security/trust-boundary risk",
              )
              appendOptionalIfHigh(
                answers.needsReliabilityLens.probability,
                ReviewerId.make("effect-reliability-reviewer"),
                "System One flagged elevated concurrency/resource risk",
              )
              appendOptionalIfHigh(
                answers.needsAdversarialLens.probability,
                ReviewerId.make("effect-adversarial-reviewer"),
                "System One flagged elevated state-transition/invariant risk",
              )
              appendOptionalIfHigh(
                answers.needsMigrationContractLens.probability,
                ReviewerId.make("effect-migration-contract-reviewer"),
                "System One flagged elevated migration/contract evolution risk",
              )
              appendOptionalIfHigh(
                answers.needsArchitectureLens.probability,
                ReviewerId.make("effect-architecture-reviewer"),
                "System One flagged elevated architectural/boundary risk",
              )

              const modelAugmentedSource = ReviewRoutingSource.make("model-augmented")

              return match(floorPlan)
                .with({ _tag: "SkipReviewPlan" }, (skip) => {
                  const targetRank = Math.max(floorRank, modelRank)
                  if (targetRank === 0 && modelExtraSelections.length === 0) {
                    return skip
                  }
                  const [firstExtra, ...restExtra] = modelExtraSelections
                  const promotedSelections: readonly [
                    ReviewerSelection,
                    ...Array<ReviewerSelection>,
                  ] =
                    firstExtra !== undefined
                      ? [firstExtra, ...restExtra]
                      : [
                          ReviewerSelection.make({
                            reviewer: ReviewerId.make("effect-ears-test-reviewer"),
                            reason: ReviewRoutingReason.make(
                              "System One escalated depth above trivial skip threshold",
                            ),
                            mandatory: false,
                          }),
                        ]
                  const selectionsImpliedRank = deriveSelectionsImpliedRank(promotedSelections)
                  const finalRank = Math.max(1, floorRank, modelRank, selectionsImpliedRank)
                  return attachReviewSlicesIfThresholdReached(
                    signals,
                    ActiveReviewPlan.make({
                      depth: activeDepthFromRank(toActiveRank(finalRank)),
                      source: modelAugmentedSource,
                      selections: promotedSelections,
                    }),
                  )
                })
                .with({ _tag: "ActiveReviewPlan" }, (active) => {
                  const combined: readonly [ReviewerSelection, ...Array<ReviewerSelection>] = [
                    active.selections[0],
                    ...active.selections.slice(1),
                    ...modelExtraSelections,
                  ]
                  const selectionsImpliedRank = deriveSelectionsImpliedRank(combined)
                  const finalRank = Math.max(floorRank, modelRank, selectionsImpliedRank)
                  const planChanged = finalRank > floorRank || modelExtraSelections.length > 0
                  if (!planChanged) {
                    return active
                  }
                  const reviewSlices =
                    active.reviewSlices !== undefined
                      ? reconcileReviewSlicesWithSelections(active.reviewSlices, combined)
                      : undefined
                  return ActiveReviewPlan.make({
                    depth: activeDepthFromRank(toActiveRank(finalRank)),
                    source: modelAugmentedSource,
                    selections: combined,
                    ...(reviewSlices !== undefined ? { reviewSlices } : {}),
                  })
                })
                .exhaustive()
            }),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})
