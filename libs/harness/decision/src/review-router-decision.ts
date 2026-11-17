import { Cause, Effect, Option, Schema } from "effect"
import * as Decision from "effect/ai/Decision"
import type * as DecisionModelTag from "effect/ai/DecisionModel"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  ActiveReviewPlan,
  ErrorReasonMessage,
  InvalidReviewRouteInputError,
  NxScopeTag,
  NxTierTag,
  ReviewChangedLines,
  ReviewDepth,
  ReviewDiffSignals,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewRoutingSource,
  ReviewSignalPath,
  ReviewerId,
  ReviewerSelection,
  SkipReviewPlan,
  isPureInterruptCause,
} from "@harness/contract"
import { match } from "ts-pattern"

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

const getDepthRank = (depth: ReviewDepth): number =>
  match<string, number>(depth)
    .with("skip", () => 0)
    .with("lite", () => 1)
    .with("focused", () => 2)
    .with("full", () => 3)
    .otherwise(() => 0)

const ACTIVE_DEPTH_BY_RANK = [
  ReviewDepth.make("lite"),
  ReviewDepth.make("lite"),
  ReviewDepth.make("focused"),
  ReviewDepth.make("full"),
] as const

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
        reason: ErrorReasonMessage.make("Absolute file paths escaping workspace root are not allowed"),
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

  return Effect.succeed(ReviewSignalPath.make(normalized))
}

export const inferReviewDiffSignals = Effect.fn("ReviewRouter.inferDiffSignals")(function* (
  input: ReviewRawDiffInput,
): Effect.fn.Return<ReviewDiffSignals, InvalidReviewRouteInputError> {
  const seen = new Set<string>()
  const changedFiles: Array<ReviewSignalPath> = []

  for (const rawFile of input.changedFiles) {
    const normalized = yield* normalizeRawFilePath(rawFile)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      changedFiles.push(normalized)
    }
  }

  const summary = input.diffSummary
  const tiers = new Set<NxTierTag>(input.touchedTiers)
  const scopes = new Set<NxScopeTag>(input.touchedScopes)

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
    changedFiles.some((p) => /^libs\/[^/]+\/contract\//.test(p)) ||
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
      (p) =>
        /^libs\/[^/]+\/infra\//.test(p) || /(?:daemon|socket|subprocess)/i.test(p),
    ) ||
    /\b(?:Scope|Schedule|withTransaction|DurableObject)\b/.test(summary)

  const hasAuthOrSecretSurface =
    (hasContractBoundaryChange && /\b(?:auth|session|api)\b/i.test(summary)) ||
    changedFiles.some((p) => /(?:auth|session|token|secret)/i.test(p)) ||
    /\b(?:auth|session|token|secret|Redacted|Config|sql|R2|idFromName)\b/i.test(summary)

  const hasArchitectureOrAdapterSurface =
    input.changedLineCount >= 180 ||
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
      p.endsWith(".ts") ||
      p.endsWith(".tsx") ||
      /^libs\/[^/]+\/docs\/specs\/[^/]+\.md$/.test(p) ||
      /\.(?:test|spec)\.(?:ts|tsx)$/.test(p),
  )

  return ReviewDiffSignals.make({
    changedFiles,
    touchedTiers: input.touchedTiers,
    touchedScopes: input.touchedScopes,
    changedLineCount: input.changedLineCount,
    diffSummary: input.diffSummary,
    hasTestOrSpecChange,
    hasContractBoundaryChange,
    hasMigrationOrInfraBindingChange,
    hasStatefulOrDeciderChange,
    hasConcurrencyOrResourceChange,
    hasAuthOrSecretSurface,
    hasArchitectureOrAdapterSurface,
    hasWebSurface,
  })
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

      if (signals.changedFiles.length === 0 || (noSurfaceFlags && signals.changedLineCount < 40)) {
        return SkipReviewPlan.make({
          depth: ReviewDepth.make("skip"),
          source: ReviewRoutingSource.make("deterministic"),
          reason: ReviewRoutingReason.make(
            signals.changedFiles.length === 0
              ? "No changed files in diff"
              : "Trivial non-code documentation edit under 40 lines",
          ),
          selections: [],
        })
      }

      const selections: Array<ReviewerSelection> = []
      const seen = new Set<ReviewerId>()

      if (signals.hasStatefulOrDeciderChange) {
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-ears-test-reviewer"),
          "Stateful or decider surface requires EARS and test coverage review",
          true,
        )
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-adversarial-reviewer"),
          "Stateful or decider surface requires adversarial boundary review",
          true,
        )
      }

      if (signals.hasTestOrSpecChange) {
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-ears-test-reviewer"),
          "TypeScript, test, or EARS spec files modified",
          true,
        )
      }

      if (signals.hasAuthOrSecretSurface) {
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-security-reviewer"),
          "Auth, secret, trust-boundary, or storage access surface touched",
          true,
        )
      }

      if (signals.hasConcurrencyOrResourceChange) {
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-reliability-reviewer"),
          "Infra, resource Scope, concurrency, or daemon surface touched",
          true,
        )
      }

      if (signals.hasWebSurface) {
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-web-reviewer"),
          "Frontend scope:web or AtomHttpApi React surface touched",
          true,
        )
      }

      if (signals.hasMigrationOrInfraBindingChange || signals.hasContractBoundaryChange) {
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-migration-contract-reviewer"),
          "Contract boundary, SQL migration, or Alchemy binding surface touched",
          true,
        )
      }

      if (signals.hasArchitectureOrAdapterSurface) {
        addSelection(
          selections,
          seen,
          ReviewerId.make("effect-architecture-reviewer"),
          "Service tier, harness core/adapter, or large (>=180 lines) surface touched",
          true,
        )
      }

      const [firstSelection, ...restSelections] = selections
      const nonEmptySelections: readonly [ReviewerSelection, ...Array<ReviewerSelection>] =
        firstSelection !== undefined
          ? [firstSelection, ...restSelections]
          : [
              ReviewerSelection.make({
                reviewer: ReviewerId.make("effect-architecture-reviewer"),
                reason: ReviewRoutingReason.make("Non-trivial change (>=40 lines) requires review"),
                mandatory: true,
              }),
            ]

      const depth =
        nonEmptySelections.length === 1 &&
        signals.changedLineCount < 40 &&
        !signals.hasStatefulOrDeciderChange &&
        !signals.hasMigrationOrInfraBindingChange
          ? ReviewDepth.make("lite")
          : nonEmptySelections.length <= 2 &&
              signals.changedLineCount < 180 &&
              !signals.hasMigrationOrInfraBindingChange
            ? ReviewDepth.make("focused")
            : ReviewDepth.make("full")

      return ActiveReviewPlan.make({
        depth,
        source: ReviewRoutingSource.make("deterministic"),
        selections: nonEmptySelections,
      })
    })
  },
)

const withRoutingSource = (
  plan: ReviewRoutingPlan,
  source: ReviewRoutingSource,
): ReviewRoutingPlan =>
  match(plan)
    .with({ _tag: "SkipReviewPlan" }, (skip) =>
      SkipReviewPlan.make({
        ...skip,
        source,
      }),
    )
    .with({ _tag: "ActiveReviewPlan" }, (active) =>
      ActiveReviewPlan.make({
        ...active,
        source,
      }),
    )
    .exhaustive()

const parseModelDepth = (choice: string): ReviewDepth =>
  match(choice)
    .with("skip", () => ReviewDepth.make("skip"))
    .with("lite", () => ReviewDepth.make("lite"))
    .with("focused", () => ReviewDepth.make("focused"))
    .with("full", () => ReviewDepth.make("full"))
    .otherwise(() => ReviewDepth.make("lite"))

export const routeReviewDiff = Effect.fn("Harness.routeReviewDiff")(function* (
  input: ReviewRawDiffInput,
): Effect.fn.Return<
  ReviewRoutingPlan,
  InvalidReviewRouteInputError,
  DecisionModelTag.DecisionModel
> {
  const signals = yield* inferReviewDiffSignals(input)
  const floorPlan = yield* decideDeterministicReviewRoute(signals)

  if (signals.changedFiles.length === 0) {
    return floorPlan
  }

  const outcome = yield* DecisionModel.decide(ReviewRouterV1, {
    input: {
      changedFiles: signals.changedFiles.join(", "),
      diffSummary: signals.diffSummary,
      changedLineCount: signals.changedLineCount,
      touchedTiers: signals.touchedTiers.join(", "),
    },
  }).pipe(
    Effect.timeoutOption("1500 millis"),
    Effect.catchCauseIf(
      (cause) => !isPureInterruptCause(cause),
      (cause) =>
        Effect.logWarning(`ReviewRouter decision fallback: ${Cause.pretty(cause)}`).pipe(
          Effect.as(Option.none()),
        ),
    ),
    Effect.orElseSucceed(() => Option.none()),
  )

  return yield* match(outcome)
    .with({ _tag: "None" }, () =>
      Effect.succeed(withRoutingSource(floorPlan, ReviewRoutingSource.make("degraded-fallback"))),
    )
    .with({ _tag: "Some" }, ({ value }) =>
      Effect.sync(() => {
        const { answers } = value
        const modelDepth = parseModelDepth(answers.recommendedDepth.label)
        const floorRank = getDepthRank(floorPlan.depth)
        const modelRank = getDepthRank(modelDepth)

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

        const targetRank = Math.max(floorRank, modelRank)
        const modelAugmentedSource = ReviewRoutingSource.make("model-augmented")

        return match(floorPlan)
          .with({ _tag: "SkipReviewPlan" }, (skip) => {
            if (targetRank === 0 && modelExtraSelections.length === 0) {
              return SkipReviewPlan.make({
                ...skip,
                source: modelAugmentedSource,
              })
            }
            const promotedRank = Math.max(1, targetRank)
            const promotedDepth = ACTIVE_DEPTH_BY_RANK[promotedRank] ?? ReviewDepth.make("lite")
            const [firstExtra, ...restExtra] = modelExtraSelections
            const promotedSelections: readonly [ReviewerSelection, ...Array<ReviewerSelection>] =
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
            return ActiveReviewPlan.make({
              depth: promotedDepth,
              source: modelAugmentedSource,
              selections: promotedSelections,
            })
          })
          .with({ _tag: "ActiveReviewPlan" }, (active) => {
            const combined: readonly [ReviewerSelection, ...Array<ReviewerSelection>] = [
              active.selections[0],
              ...active.selections.slice(1),
              ...modelExtraSelections,
            ]
            const escalatedDepth = ACTIVE_DEPTH_BY_RANK[targetRank] ?? active.depth
            return ActiveReviewPlan.make({
              depth: escalatedDepth,
              source: modelAugmentedSource,
              selections: combined,
            })
          })
          .exhaustive()
      }),
    )
    .exhaustive()
})
