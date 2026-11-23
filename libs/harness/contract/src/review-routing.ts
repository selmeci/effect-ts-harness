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

export const ReviewDepthRank = Schema.Literals([0, 1, 2, 3]).pipe(Schema.brand("ReviewDepthRank"))
export type ReviewDepthRank = typeof ReviewDepthRank.Type

export const REVIEW_DEPTH_RANK = {
  skip: ReviewDepthRank.make(0),
  lite: ReviewDepthRank.make(1),
  focused: ReviewDepthRank.make(2),
  full: ReviewDepthRank.make(3),
} as const satisfies Record<(typeof REVIEW_DEPTH_LEVELS)[number], ReviewDepthRank>

const lookupReviewDepthRank = (depth: (typeof REVIEW_DEPTH_LEVELS)[number]): ReviewDepthRank =>
  REVIEW_DEPTH_RANK[depth]

export const getReviewDepthRank = (depth: ReviewDepth): ReviewDepthRank =>
  lookupReviewDepthRank(depth)

const SAFE_PATH_SEGMENT = "(?!\\.\\.?(?:\\/|$))[^\\0\\\\/\\s](?:[^\\0\\\\/]*[^\\0\\\\/\\s])?"
const SAFE_REVIEW_SIGNAL_PATH_RE = new RegExp(
  `^(?![A-Za-z]:)${SAFE_PATH_SEGMENT}(?:\\/${SAFE_PATH_SEGMENT})*$`,
)

export const ReviewSignalPath = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 512)),
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(SAFE_REVIEW_SIGNAL_PATH_RE)),
  Schema.brand("ReviewSignalPath"),
)
export type ReviewSignalPath = typeof ReviewSignalPath.Type

export const ReviewChangedLines = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("ReviewChangedLines"),
)
export type ReviewChangedLines = typeof ReviewChangedLines.Type

export const ReviewSliceFileCount = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  Schema.check(Schema.isLessThanOrEqualTo(200)),
  Schema.brand("ReviewSliceFileCount"),
)
export type ReviewSliceFileCount = typeof ReviewSliceFileCount.Type

export const REVIEW_SLICE_FILE_THRESHOLD: ReviewSliceFileCount = ReviewSliceFileCount.make(12)

export const ReviewSliceId = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(1, 128)),
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9._:/#-]*$/)),
  Schema.brand("ReviewSliceId"),
)
export type ReviewSliceId = typeof ReviewSliceId.Type

export const REMEDIATION_FINDING_SEVERITIES = ["blocker", "critical", "major", "minor"] as const

export const RemediationFindingSeverity = Schema.Literals(REMEDIATION_FINDING_SEVERITIES).pipe(
  Schema.brand("RemediationFindingSeverity"),
)
export type RemediationFindingSeverity = typeof RemediationFindingSeverity.Type

export const RemediationReviewContext = Schema.Struct({
  priorSpecialists: Schema.NonEmptyArray(ReviewerId).pipe(Schema.check(Schema.isMaxLength(16))),
  maxSeverity: RemediationFindingSeverity,
})
export type RemediationReviewContext = typeof RemediationReviewContext.Type

export const ReviewTimeoutMillis = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(100)),
  Schema.check(Schema.isLessThanOrEqualTo(30000)),
  Schema.brand("ReviewTimeoutMillis"),
)
export type ReviewTimeoutMillis = typeof ReviewTimeoutMillis.Type

export const DEFAULT_REVIEW_ROUTE_TIMEOUT_MS: ReviewTimeoutMillis = ReviewTimeoutMillis.make(1500)

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
  Schema.check(Schema.isMaxLength(512)),
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
  changedFiles: Schema.Array(ReviewRawFileInput).pipe(Schema.check(Schema.isBetweenLength(1, 200))),
  diffSummary: ReviewSummaryText,
  changedLineCount: ReviewChangedLines,
  touchedTiers: Schema.Array(NxTierTag).pipe(Schema.check(Schema.isMaxLength(16))),
  touchedScopes: Schema.Array(NxScopeTag).pipe(Schema.check(Schema.isMaxLength(16))),
  timeoutMs: Schema.optional(ReviewTimeoutMillis),
  remediationContext: Schema.optional(RemediationReviewContext),
})
export type ReviewRawDiffInput = typeof ReviewRawDiffInput.Type

export const ReviewDiffSignals = Schema.Struct({
  changedFiles: Schema.Array(ReviewSignalPath).pipe(Schema.check(Schema.isBetweenLength(1, 200))),
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
  remediationContext: Schema.optional(RemediationReviewContext),
})
export type ReviewDiffSignals = typeof ReviewDiffSignals.Type

export const ReviewerSelection = Schema.Struct({
  reviewer: ReviewerId,
  reason: ReviewRoutingReason,
  mandatory: Schema.Boolean,
})
export type ReviewerSelection = typeof ReviewerSelection.Type

export const ReviewSlicePlan = Schema.Struct({
  sliceId: ReviewSliceId,
  label: ReviewRoutingReason,
  files: Schema.NonEmptyArray(ReviewSignalPath),
  selections: Schema.NonEmptyArray(ReviewerSelection),
})
export type ReviewSlicePlan = typeof ReviewSlicePlan.Type

export const SkipReviewPlan = Schema.TaggedStruct("SkipReviewPlan", {
  depth: Schema.Literal(ReviewDepth.make("skip")),
  source: ReviewRoutingSource,
  reason: ReviewRoutingReason,
  degradedReason: Schema.optional(ErrorReasonMessage),
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
  degradedReason: Schema.optional(ErrorReasonMessage),
  selections: Schema.NonEmptyArray(ReviewerSelection),
  reviewSlices: Schema.optional(Schema.NonEmptyArray(ReviewSlicePlan)),
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
  warnings: Schema.Array(ErrorReasonMessage),
  degraded: Schema.Boolean,
  degradedReason: Schema.optional(ErrorReasonMessage),
  evaluationError: Schema.optional(ErrorReasonMessage),
  reviewSlices: Schema.optional(Schema.NonEmptyArray(ReviewSlicePlan)),
})
export type ReviewRouteToolOutput = typeof ReviewRouteToolOutput.Type
