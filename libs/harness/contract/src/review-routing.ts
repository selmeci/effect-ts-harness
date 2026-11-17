import { Schema } from "effect"
import { EnclosingSymbolName } from "./ast-and-gate-primitives.js"
import { NxScopeTag, NxTierTag } from "./tier-topology.js"
import { ErrorReasonMessage } from "./workspace-and-process.js"

export const SPECIALIST_REVIEWER_IDS = [
  "effect-ears-test-reviewer",
  "effect-security-reviewer",
  "effect-reliability-reviewer",
  "effect-adversarial-reviewer",
  "effect-web-reviewer",
  "effect-migration-contract-reviewer",
  "effect-architecture-reviewer",
] as const

export const ReviewerId = Schema.Literals(SPECIALIST_REVIEWER_IDS).pipe(Schema.brand("ReviewerId"))
export type ReviewerId = typeof ReviewerId.Type

export const REVIEW_DEPTH_LEVELS = ["skip", "lite", "focused", "full"] as const

export const ReviewDepth = Schema.Literals(REVIEW_DEPTH_LEVELS).pipe(Schema.brand("ReviewDepth"))
export type ReviewDepth = typeof ReviewDepth.Type

export const ReviewSignalPath = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("ReviewSignalPath"),
)
export type ReviewSignalPath = typeof ReviewSignalPath.Type

export const ReviewChangedLines = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("ReviewChangedLines"),
)
export type ReviewChangedLines = typeof ReviewChangedLines.Type

export const ReviewSummaryText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(4096)),
  Schema.brand("ReviewSummaryText"),
)
export type ReviewSummaryText = typeof ReviewSummaryText.Type

export const ReviewRoutingReason = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.brand("ReviewRoutingReason"),
)
export type ReviewRoutingReason = typeof ReviewRoutingReason.Type

export const ReviewRoutingSource = Schema.Literals([
  "deterministic",
  "model-augmented",
  "degraded-fallback",
]).pipe(Schema.brand("ReviewRoutingSource"))
export type ReviewRoutingSource = typeof ReviewRoutingSource.Type

export const ReviewRawFileInput = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(1024)),
  Schema.brand("ReviewRawFileInput"),
)
export type ReviewRawFileInput = typeof ReviewRawFileInput.Type

export class InvalidReviewRouteInputError extends Schema.TaggedError<InvalidReviewRouteInputError>()(
  "InvalidReviewRouteInputError",
  {
    offendingPath: ReviewRawFileInput,
    reason: ErrorReasonMessage,
  },
) {}

export const ReviewRawDiffInput = Schema.Struct({
  changedFiles: Schema.Array(ReviewRawFileInput).pipe(Schema.check(Schema.isMaxLength(200))),
  diffSummary: ReviewSummaryText,
  changedLineCount: ReviewChangedLines,
  touchedTiers: Schema.Array(NxTierTag).pipe(Schema.check(Schema.isMaxLength(16))),
  touchedScopes: Schema.Array(NxScopeTag).pipe(Schema.check(Schema.isMaxLength(16))),
})
export type ReviewRawDiffInput = typeof ReviewRawDiffInput.Type

export const ReviewDiffSignals = Schema.Struct({
  changedFiles: Schema.Array(ReviewSignalPath),
  touchedTiers: Schema.Array(NxTierTag),
  touchedScopes: Schema.Array(NxScopeTag),
  changedLineCount: ReviewChangedLines,
  diffSummary: ReviewSummaryText,
  hasTestOrSpecChange: Schema.Boolean,
  hasContractBoundaryChange: Schema.Boolean,
  hasMigrationOrInfraBindingChange: Schema.Boolean,
  hasStatefulOrDeciderChange: Schema.Boolean,
  hasConcurrencyOrResourceChange: Schema.Boolean,
  hasAuthOrSecretSurface: Schema.Boolean,
  hasArchitectureOrAdapterSurface: Schema.Boolean,
  hasWebSurface: Schema.Boolean,
})
export type ReviewDiffSignals = typeof ReviewDiffSignals.Type

export const ReviewerSelection = Schema.Struct({
  reviewer: ReviewerId,
  reason: ReviewRoutingReason,
  mandatory: Schema.Boolean,
})
export type ReviewerSelection = typeof ReviewerSelection.Type

export const SkipReviewPlan = Schema.TaggedStruct("SkipReviewPlan", {
  depth: Schema.Literal(ReviewDepth.make("skip")),
  source: ReviewRoutingSource,
  reason: ReviewRoutingReason,
  selections: Schema.Tuple([]),
})
export type SkipReviewPlan = typeof SkipReviewPlan.Type

export const ActiveReviewPlan = Schema.TaggedStruct("ActiveReviewPlan", {
  depth: Schema.Literals([
    ReviewDepth.make("lite"),
    ReviewDepth.make("focused"),
    ReviewDepth.make("full"),
  ]),
  source: ReviewRoutingSource,
  selections: Schema.NonEmptyArray(ReviewerSelection),
})
export type ActiveReviewPlan = typeof ActiveReviewPlan.Type

export const ReviewRoutingPlan = Schema.Union([SkipReviewPlan, ActiveReviewPlan])
export type ReviewRoutingPlan = typeof ReviewRoutingPlan.Type

export const ReviewGraphContextBundle = Schema.Struct({
  touchedSymbols: Schema.Array(EnclosingSymbolName),
  reachingTests: Schema.Array(EnclosingSymbolName),
  governanceRefs: Schema.Array(ReviewSignalPath),
})
export type ReviewGraphContextBundle = typeof ReviewGraphContextBundle.Type

export const ReviewRouteToolOutput = Schema.Struct({
  plan: ReviewRoutingPlan,
  signals: ReviewDiffSignals,
  graphContext: ReviewGraphContextBundle,
})
export type ReviewRouteToolOutput = typeof ReviewRouteToolOutput.Type
