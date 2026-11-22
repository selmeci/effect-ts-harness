import { Effect, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import type * as DecisionModelTag from "effect/ai/DecisionModel"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  ActiveReviewPlan,
  DEFAULT_REVIEW_ROUTE_TIMEOUT_MS,
  ErrorReasonMessage,
  InvalidReviewRouteInputError,
  NxScopeTag,
  NxTierTag,
  REMEDIATION_FINDING_SEVERITIES,
  REVIEW_DEPTH_RANK,
  type RemediationFindingSeverity,
  RemediationReviewContext,
  ReviewChangedLines,
  ReviewDepth,
  type ReviewDepthRank,
  ReviewDiffSignals,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  ReviewSignalPath,
  type ReviewSlicePlan,
  ReviewSummaryText,
  ReviewerId,
  ReviewerSelection,
  SkipReviewPlan,
  getReviewDepthRank,
  toErrorReasonMessage,
} from "@harness/contract"
import { match } from "ts-pattern"
import { partitionDiffReviewSlices } from "./review-slice-partitioner.js"

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

const isNonGovernanceDocPath = (filePath: ReviewSignalPath): boolean => {
  if (
    filePath.startsWith("adapters/") ||
    filePath.startsWith("agent-patterns/") ||
    /(?:^|\/)docs\/(?:specs|adr)\//.test(filePath)
  ) {
    return false
  }
  return /\.(?:md|mdx|txt)$/i.test(filePath) || /(?:^|\/)LICENSE[^/]*$/.test(filePath)
}

const normalizeRawFilePath = (
  raw: ReviewRawFileInput,
): Effect.Effect<ReviewSignalPath, InvalidReviewRouteInputError> => {
  if (raw.includes("\0")) {
    return Effect.fail(
      new InvalidReviewRouteInputError({
        offendingPath: raw,
        reason: ErrorReasonMessage.make("File path contains a disallowed null byte"),
      }),
    )
  }

  let normalized = raw.trim().replaceAll("\\", "/")
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2)
  }

  if (normalized.length === 0) {
    return Effect.fail(
      new InvalidReviewRouteInputError({
        offendingPath: raw,
        reason: ErrorReasonMessage.make("File path must not be empty or whitespace-only"),
      }),
    )
  }

  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return Effect.fail(
      new InvalidReviewRouteInputError({
        offendingPath: raw,
        reason: ErrorReasonMessage.make(
          "Absolute file paths escaping workspace root are not allowed",
        ),
      }),
    )
  }

  const segments = normalized.split("/")
  if (segments.some((seg) => seg === "" || seg === "." || seg === ".." || seg !== seg.trim())) {
    return Effect.fail(
      new InvalidReviewRouteInputError({
        offendingPath: raw,
        reason: ErrorReasonMessage.make("Invalid or traversal path segment is not allowed"),
      }),
    )
  }

  return Schema.decodeEffect(ReviewSignalPath)(normalized).pipe(
    Effect.mapError(
      (schemaError) =>
        new InvalidReviewRouteInputError({
          offendingPath: ReviewRawFileInput.make(raw.slice(0, 512)),
          reason: toErrorReasonMessage(schemaError),
        }),
    ),
  )
}

export const normalizeReviewFilePaths = (
  rawFiles: ReadonlyArray<ReviewRawFileInput>,
): Effect.Effect<ReadonlyArray<ReviewSignalPath>, InvalidReviewRouteInputError> =>
  Effect.gen(function* () {
    if (rawFiles.length === 0) {
      return yield* new InvalidReviewRouteInputError({
        offendingPath: ReviewRawFileInput.make(""),
        reason: ErrorReasonMessage.make("changedFiles must contain at least one file path"),
      })
    }

    const seen = new Set<string>()
    const changedFiles: Array<ReviewSignalPath> = []

    for (const rawFile of rawFiles) {
      const normalized = yield* normalizeRawFilePath(rawFile)
      if (!seen.has(normalized)) {
        seen.add(normalized)
        changedFiles.push(normalized)
      }
    }

    return changedFiles
  })

interface ReviewSurfaceFlags {
  readonly hasTestOrSpecChange: boolean
  readonly hasContractBoundaryChange: boolean
  readonly hasMigrationOrInfraBindingChange: boolean
  readonly hasStatefulOrDeciderChange: boolean
  readonly hasConcurrencyOrResourceChange: boolean
  readonly hasAuthOrSecretSurface: boolean
  readonly hasArchitectureOrAdapterSurface: boolean
  readonly hasWebSurface: boolean
}

const isEscalatingRemediationSeverity = (severity: RemediationFindingSeverity): boolean => {
  const level: (typeof REMEDIATION_FINDING_SEVERITIES)[number] = severity
  return match(level)
    .with("blocker", "critical", "major", () => true)
    .with("minor", () => false)
    .exhaustive()
}

const computeFilePathSurfaceFlags = (
  changedFiles: ReadonlyArray<ReviewSignalPath>,
  tiers: ReadonlySet<NxTierTag>,
  scopes: ReadonlySet<NxScopeTag>,
  summary: ReviewSummaryText,
  changedLineCount: ReviewChangedLines,
): ReviewSurfaceFlags => {
  const hasWebSurface =
    scopes.has(NxScopeTag.make("scope:web")) ||
    changedFiles.some((p) => /^apps\/[^/]+-web\//.test(p) || p.endsWith(".tsx")) ||
    /\b(?:AtomHttpApi|useAtomValue|useAtomSend)\b/.test(summary)

  const hasMigrationOrInfraBindingChange =
    changedFiles.some(
      (p) =>
        /(?:^|\/)migrations\/[^/]+\.sql$/.test(p) ||
        /migrator/i.test(p) ||
        /(?:^|\/)alchemy\.run\.ts$/.test(p),
    ) || /\b(?:SqliteMigrator|D1Database|DurableObjectNamespace|R2Bucket)\b/.test(summary)

  const hasContractBoundaryChange =
    tiers.has(NxTierTag.make("type:contract")) ||
    changedFiles.some(
      (p) => /^libs\/[^/]+\/contract\//.test(p) || /(?:^|\/)openapi[^/]*\.(?:json|ya?ml)$/i.test(p),
    ) ||
    /\b(?:HttpApi|RpcGroup|Schema\.Tagged)\b/.test(summary)

  const hasStatefulOrDeciderChange =
    tiers.has(NxTierTag.make("type:core")) ||
    tiers.has(NxTierTag.make("type:domain")) ||
    changedFiles.some(
      (p) =>
        p.startsWith("libs/es/") ||
        /^libs\/[^/]+\/domain\//.test(p) ||
        p.startsWith("libs/harness/gates/") ||
        p.startsWith("tools/oxlint/") ||
        /(?:decider|outbox|projector)/i.test(p),
    )

  const hasConcurrencyOrResourceChange =
    tiers.has(NxTierTag.make("type:infra")) ||
    changedFiles.some(
      (p) => /^libs\/[^/]+\/infra\//.test(p) || /(?:daemon|socket|subprocess|queue|alarm)/i.test(p),
    ) ||
    /\b(?:Scope|Schedule|withTransaction|DurableObject|D1Database|Queue|Queues|alarm)\b/.test(
      summary,
    )

  const hasAuthOrSecretSurface =
    changedFiles.some((p) =>
      /(?:^|[/_.-])(?:auth|authn|authz|oauth|jwt|csrf|cors|permission|session|token|secret|credential)s?(?:$|[/_.-])/i.test(
        p,
      ),
    ) ||
    /\b(?:auth|authn|authz|authentication|authorization|oauth|jwt|session|secret|secrets|credential|credentials|password|api[-_]?key|Redacted|Config\.redacted|idFromName|IDOR|path[-_ ]traversal)\b/i.test(
      summary,
    )

  const hasArchitectureOrAdapterSurface =
    changedLineCount >= 180 ||
    tiers.has(NxTierTag.make("type:service")) ||
    changedFiles.some(
      (p) =>
        p.startsWith("adapters/") ||
        p.startsWith("apps/harness-mcp/") ||
        p.startsWith("apps/harness-cli/") ||
        p.startsWith("libs/es/") ||
        p.startsWith("libs/harness/") ||
        p.startsWith("agent-patterns/"),
    )

  const hasTestOrSpecChange = changedFiles.some(
    (p) =>
      /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) ||
      /(?:^|\/)docs\/(?:specs|adr)\/[^/]+\.md$/.test(p),
  )

  return {
    hasTestOrSpecChange,
    hasContractBoundaryChange,
    hasMigrationOrInfraBindingChange,
    hasStatefulOrDeciderChange,
    hasConcurrencyOrResourceChange,
    hasAuthOrSecretSurface,
    hasArchitectureOrAdapterSurface,
    hasWebSurface,
  }
}

export const inferReviewDiffSignals = Effect.fn("ReviewRouter.inferDiffSignals")(function* (
  input: ReviewRawDiffInput,
): Effect.fn.Return<ReviewDiffSignals, InvalidReviewRouteInputError> {
  const changedFiles = yield* normalizeReviewFilePaths(input.changedFiles)

  const tiers = new Set<NxTierTag>(input.touchedTiers)
  const scopes = new Set<NxScopeTag>(input.touchedScopes)
  const flags = computeFilePathSurfaceFlags(
    changedFiles,
    tiers,
    scopes,
    input.diffSummary,
    input.changedLineCount,
  )

  let remediationContext: RemediationReviewContext | undefined = undefined
  if (input.remediationContext !== undefined) {
    const deduped: Array<ReviewerId> = []
    const seen = new Set<ReviewerId>()
    for (const sp of input.remediationContext.priorSpecialists) {
      if (!seen.has(sp)) {
        seen.add(sp)
        deduped.push(sp)
      }
    }
    remediationContext = RemediationReviewContext.make({
      priorSpecialists: [deduped[0]!, ...deduped.slice(1)],
      maxSeverity: input.remediationContext.maxSeverity,
    })
  }

  return yield* Schema.decodeEffect(ReviewDiffSignals)({
    changedFiles,
    touchedTiers: input.touchedTiers,
    touchedScopes: input.touchedScopes,
    changedLineCount: input.changedLineCount,
    diffSummary: input.diffSummary,
    ...flags,
    ...(remediationContext !== undefined ? { remediationContext } : {}),
  }).pipe(
    Effect.mapError(
      (schemaError) =>
        new InvalidReviewRouteInputError({
          offendingPath: input.changedFiles[0] ?? ReviewRawFileInput.make(""),
          reason: toErrorReasonMessage(schemaError),
        }),
    ),
  )
})

const addSelection = (
  selections: Array<ReviewerSelection>,
  seen: Set<ReviewerId>,
  reviewer: ReviewerId,
  reason: string,
  mandatory: boolean,
): void => {
  if (seen.has(reviewer)) {
    return
  }
  seen.add(reviewer)
  selections.push(
    ReviewerSelection.make({
      reviewer,
      reason: ReviewRoutingReason.make(reason),
      mandatory,
    }),
  )
}

const collectSurfaceSelections = (
  flags: ReviewSurfaceFlags,
  remediationContext: RemediationReviewContext | undefined,
): Array<ReviewerSelection> => {
  const selections: Array<ReviewerSelection> = []
  const seen = new Set<ReviewerId>()
  const push = (id: ReviewerId, reason: string): void =>
    addSelection(selections, seen, id, reason, true)

  if (flags.hasStatefulOrDeciderChange) {
    push(
      ReviewerId.make("effect-ears-test-reviewer"),
      "Stateful or decider surface requires EARS and test coverage review",
    )
    push(
      ReviewerId.make("effect-adversarial-reviewer"),
      "Stateful or decider surface requires adversarial boundary review",
    )
  }
  if (flags.hasTestOrSpecChange) {
    push(
      ReviewerId.make("effect-ears-test-reviewer"),
      "TypeScript, test, or EARS spec files modified",
    )
  }
  if (flags.hasAuthOrSecretSurface) {
    push(
      ReviewerId.make("effect-security-reviewer"),
      "Auth, secret, trust-boundary, or storage access surface touched",
    )
  }
  if (flags.hasConcurrencyOrResourceChange) {
    push(
      ReviewerId.make("effect-reliability-reviewer"),
      "Infra, resource Scope, concurrency, or daemon surface touched",
    )
  }
  if (flags.hasWebSurface) {
    push(
      ReviewerId.make("effect-web-reviewer"),
      "Frontend scope:web or AtomHttpApi React surface touched",
    )
  }
  if (flags.hasMigrationOrInfraBindingChange || flags.hasContractBoundaryChange) {
    push(
      ReviewerId.make("effect-migration-contract-reviewer"),
      "Contract boundary, SQL migration, or Alchemy binding surface touched",
    )
  }
  if (flags.hasArchitectureOrAdapterSurface) {
    push(
      ReviewerId.make("effect-architecture-reviewer"),
      "Service tier, harness core/adapter, or large (>=180 lines) surface touched",
    )
  }
  if (
    remediationContext !== undefined &&
    isEscalatingRemediationSeverity(remediationContext.maxSeverity)
  ) {
    for (const priorReviewer of remediationContext.priorSpecialists) {
      push(
        priorReviewer,
        `Mandatory second-pass remediation re-audit for prior ${remediationContext.maxSeverity} finding`,
      )
    }
  }

  return selections
}

const computeSliceSelections = (
  signals: ReviewDiffSignals,
  sliceFiles: readonly [ReviewSignalPath, ...Array<ReviewSignalPath>],
  wholePlan: ActiveReviewPlan,
): readonly [ReviewerSelection, ...Array<ReviewerSelection>] => {
  const sliceFlags = computeFilePathSurfaceFlags(
    sliceFiles,
    new Set(),
    new Set(),
    ReviewSummaryText.make(""),
    ReviewChangedLines.make(0),
  )
  const sliceSelections = collectSurfaceSelections(sliceFlags, signals.remediationContext)
  const [firstSliceSel, ...restSliceSel] = sliceSelections
  return firstSliceSel !== undefined ? [firstSliceSel, ...restSliceSel] : [wholePlan.selections[0]]
}

/** Attaches disjoint package-grouped `reviewSlices` when `changedFiles` meets `REVIEW_SLICE_FILE_THRESHOLD`. */
export const attachReviewSlicesIfThresholdReached = (
  signals: ReviewDiffSignals,
  plan: ReviewRoutingPlan,
): ReviewRoutingPlan =>
  match(plan)
    .with({ _tag: "SkipReviewPlan" }, (skip) => skip)
    .with({ _tag: "ActiveReviewPlan" }, (active) => {
      if (active.reviewSlices !== undefined) {
        return active
      }
      const reviewSlices: readonly [ReviewSlicePlan, ...Array<ReviewSlicePlan>] | undefined =
        partitionDiffReviewSlices(signals, active, (sliceFiles) =>
          computeSliceSelections(signals, sliceFiles, active),
        )
      return reviewSlices !== undefined
        ? ActiveReviewPlan.make({ ...active, reviewSlices })
        : active
    })
    .exhaustive()

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
                  return ActiveReviewPlan.make({
                    depth: activeDepthFromRank(toActiveRank(finalRank)),
                    source: modelAugmentedSource,
                    selections: combined,
                    ...(active.reviewSlices !== undefined
                      ? { reviewSlices: active.reviewSlices }
                      : {}),
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
