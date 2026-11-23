import { Effect, Schema } from "effect"
import {
  ActiveReviewPlan,
  ErrorReasonMessage,
  InvalidReviewRouteInputError,
  NxScopeTag,
  NxTierTag,
  REMEDIATION_FINDING_SEVERITIES,
  type RemediationFindingSeverity,
  RemediationReviewContext,
  ReviewChangedLines,
  ReviewDiffSignals,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  type ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewSignalPath,
  ReviewSlicePlan,
  ReviewSummaryText,
  ReviewerId,
  ReviewerSelection,
  toErrorReasonMessage,
} from "@harness/contract"
import { match } from "ts-pattern"
import { partitionDiffReviewSlices } from "./review-slice-partitioner.js"

/** Returns true for plain non-governance docs eligible for `SkipReviewPlan` when under 40 lines. */
export const isNonGovernanceDocPath = (filePath: ReviewSignalPath): boolean => {
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

/** Validates, normalizes, and deduplicates raw workspace-relative diff paths. */
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

export interface ReviewSurfaceFlags {
  readonly hasTestOrSpecChange: boolean
  readonly hasContractBoundaryChange: boolean
  readonly hasMigrationOrInfraBindingChange: boolean
  readonly hasStatefulOrDeciderChange: boolean
  readonly hasConcurrencyOrResourceChange: boolean
  readonly hasAuthOrSecretSurface: boolean
  readonly hasArchitectureOrAdapterSurface: boolean
  readonly hasWebSurface: boolean
}

/** Returns true when prior remediation severity mandates `focused+` specialist re-audit. */
export const isEscalatingRemediationSeverity = (severity: RemediationFindingSeverity): boolean => {
  const level: (typeof REMEDIATION_FINDING_SEVERITIES)[number] = severity
  return match(level)
    .with("blocker", "critical", "major", () => true)
    .with("minor", () => false)
    .exhaustive()
}

/** Derives observable review surface booleans from changed files, Nx tags, and diff summary. */
export const computeFilePathSurfaceFlags = (
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
        /^libs\/[^/]+\/service\//.test(p) ||
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

/** Maps active surface flags and escalating `remediationContext` to mandatory specialist selections. */
export const collectSurfaceSelections = (
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

/** Computes per-slice specialist selections with full whole-plan fallback for unclassified slices. */
export const computeSliceSelections = (
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
  return firstSliceSel !== undefined
    ? [firstSliceSel, ...restSliceSel]
    : [wholePlan.selections[0], ...wholePlan.selections.slice(1)]
}

/**
 * Ensures the union of selections across `slices` equals `wholeSelections` (adding any
 * whole-diff specialists triggered by tags, summary, line count, model augmentation, or
 * diagnostics that were absent from individual file-path slices).
 */
export const reconcileReviewSlicesWithSelections = (
  slices: readonly [ReviewSlicePlan, ...Array<ReviewSlicePlan>],
  wholeSelections: readonly [ReviewerSelection, ...Array<ReviewerSelection>],
): readonly [ReviewSlicePlan, ...Array<ReviewSlicePlan>] => {
  const wholeReviewers = new Set<ReviewerId>(wholeSelections.map((s) => s.reviewer))
  const sliceUnion = new Set<ReviewerId>()
  let needsSync = false

  for (const slice of slices) {
    for (const sel of slice.selections) {
      if (wholeReviewers.has(sel.reviewer)) {
        sliceUnion.add(sel.reviewer)
      } else {
        needsSync = true
      }
    }
  }

  const missingWhole = wholeSelections.filter((sel) => !sliceUnion.has(sel.reviewer))
  if (!needsSync && missingWhole.length === 0) {
    return slices
  }

  const updated = slices.map((slice) => {
    const merged: Array<ReviewerSelection> = []
    const seen = new Set<ReviewerId>()
    for (const sel of slice.selections) {
      if (wholeReviewers.has(sel.reviewer) && !seen.has(sel.reviewer)) {
        seen.add(sel.reviewer)
        merged.push(sel)
      }
    }
    for (const extra of missingWhole) {
      if (!seen.has(extra.reviewer)) {
        seen.add(extra.reviewer)
        merged.push(extra)
      }
    }
    const nextSelections: readonly [ReviewerSelection, ...Array<ReviewerSelection>] =
      merged.length > 0
        ? [merged[0]!, ...merged.slice(1)]
        : [wholeSelections[0], ...wholeSelections.slice(1)]
    return ReviewSlicePlan.make({
      ...slice,
      selections: nextSelections,
    })
  })
  return [updated[0]!, ...updated.slice(1)]
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
        const reconciledExisting = reconcileReviewSlicesWithSelections(
          active.reviewSlices,
          active.selections,
        )
        return reconciledExisting === active.reviewSlices
          ? active
          : ActiveReviewPlan.make({ ...active, reviewSlices: reconciledExisting })
      }
      const rawSlices: readonly [ReviewSlicePlan, ...Array<ReviewSlicePlan>] | undefined =
        partitionDiffReviewSlices(signals, active, (sliceFiles) =>
          computeSliceSelections(signals, sliceFiles, active),
        )
      if (rawSlices === undefined) {
        return active
      }
      const reviewSlices = reconcileReviewSlicesWithSelections(rawSlices, active.selections)
      return ActiveReviewPlan.make({ ...active, reviewSlices })
    })
    .exhaustive()
