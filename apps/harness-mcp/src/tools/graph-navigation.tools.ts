import * as path from "node:path"
import { Cause, Effect, Option, Schema } from "effect"
import type * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  InvalidReviewRouteInputError,
  type NxScopeTag,
  type NxTierTag,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRouteToolOutput,
  isPureInterruptCause,
  toErrorReasonMessage,
} from "@harness/contract"
import {
  decideStructuralSearch,
  findCallees,
  findCallers,
  findTestsReaching,
  resolveNode,
} from "@harness/graph"
import {
  attachReviewSlicesIfThresholdReached,
  inferReviewDiffSignals,
  normalizeReviewFilePaths,
  routeReviewDiff,
  routeStep,
} from "@harness/decision"
import { LocalDecisionModel, nodeSyncHostIo } from "@harness/infra"
import {
  graphStatusMeta,
  isPathInsideRoot,
  McpToolName,
  type McpToolPluginDescriptor,
  normalizeProjectPath,
  ProjectPathEscapeError,
  resolveDefaultRepoRoot,
  resolveGraphWithStatus,
  type ServerOptions,
} from "./mcp-helpers.js"
import {
  buildReviewGraphContextBundle,
  collectManifestTagsForFiles,
  decodeReviewRouteInput,
  escalatePlanOnDiagnostics,
  resolveReviewRouteTimeoutMs,
  type ReviewRouteExecutionContext,
  ReviewRouteInputSchema,
} from "./review-route-helpers.js"

export { isPathInsideRoot, normalizeProjectPath, resolveDefaultRepoRoot }
export type { ReviewRouteExecutionContext }

const BoundedSymbolOrSpan = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512)))
const BoundedRepoRoot = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 1024)))

const ResolveInputSchema = Schema.Struct({
  symbolOrSpan: BoundedSymbolOrSpan.annotate({
    description: "Symbol or span name to resolve",
  }),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const CallersInputSchema = Schema.Struct({
  symbolOrSpan: BoundedSymbolOrSpan.annotate({
    description: "Symbol or span name to query callers for",
  }),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const CalleesInputSchema = Schema.Struct({
  symbolOrSpan: BoundedSymbolOrSpan.annotate({
    description: "Symbol or span name to query callees for",
  }),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const TestsReachingInputSchema = Schema.Struct({
  symbolOrSpan: BoundedSymbolOrSpan.annotate({
    description: "Symbol or span name to find reaching tests for",
  }),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const StructuralSearchInputSchema = Schema.Struct({
  pattern: Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 2048))).annotate({
    description: "ast-grep pattern to search for across workspace TypeScript files",
  }),
  filePath: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512))).annotate({
      description: "Optional relative or absolute file path to scope search to a single file",
    }),
  ),
  paths: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512))))
      .pipe(Schema.check(Schema.isMaxLength(100)))
      .annotate({
        description: "Optional list of file or directory paths to scope search",
      }),
  ),
  subDirs: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 256))))
      .pipe(Schema.check(Schema.isMaxLength(50)))
      .annotate({
        description: "Optional workspace subdirectories to search (defaults to ['libs', 'apps'])",
      }),
  ),
  repoRoot: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 1024))).annotate({
      description: "Optional repository or worktree root directory",
    }),
  ),
})

const RouteInputSchema = Schema.Struct({
  planStep: Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 4096))).annotate({
    description: "Implementation plan step text to route to an Effect idiom block",
  }),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const decodeResolveInput = Schema.decodeUnknownEffect(ResolveInputSchema)
const decodeStructuralSearchInput = Schema.decodeUnknownEffect(StructuralSearchInputSchema)
const decodeRouteInput = Schema.decodeUnknownEffect(RouteInputSchema)

export const executeReviewRouteTool = Effect.fn("HarnessMcp.routeReview")(function* (
  input: ReviewRawDiffInput,
  context?: ReviewRouteExecutionContext,
): Effect.fn.Return<
  ReviewRouteToolOutput,
  InvalidReviewRouteInputError,
  DecisionModel.DecisionModel
> {
  yield* Schema.decodeEffect(ReviewRawDiffInput)(input).pipe(
    Effect.mapError(
      (schemaError) =>
        new InvalidReviewRouteInputError({
          offendingPath: input.changedFiles[0] ?? ReviewRawFileInput.make(""),
          reason: toErrorReasonMessage(schemaError),
        }),
    ),
  )

  const normalizedFiles = yield* normalizeReviewFilePaths(input.changedFiles)

  const manifestResult = yield* Effect.gen(function* () {
    if (context?.repoRoot === undefined) {
      return {
        tiers: [] as ReadonlyArray<NxTierTag>,
        scopes: [] as ReadonlyArray<NxScopeTag>,
        warnings: [
          ErrorReasonMessage.make(
            "No repoRoot supplied; manifest tier/scope enrichment unavailable",
          ),
        ] as ReadonlyArray<ErrorReasonMessage>,
      }
    }
    if (!nodeSyncHostIo.existsSync(context.repoRoot)) {
      return {
        tiers: [] as ReadonlyArray<NxTierTag>,
        scopes: [] as ReadonlyArray<NxScopeTag>,
        warnings: [
          toErrorReasonMessage(`Configured repoRoot does not exist on disk: ${context.repoRoot}`),
        ] as ReadonlyArray<ErrorReasonMessage>,
      }
    }
    return yield* collectManifestTagsForFiles(context.repoRoot, normalizedFiles)
  })

  const mergedTiers = [...new Set([...input.touchedTiers, ...manifestResult.tiers])]
  const mergedScopes = [...new Set([...input.touchedScopes, ...manifestResult.scopes])]

  const enrichedInput = yield* Schema.decodeEffect(ReviewRawDiffInput)({
    ...input,
    changedFiles: normalizedFiles,
    touchedTiers: mergedTiers,
    touchedScopes: mergedScopes,
  }).pipe(
    Effect.mapError(
      (schemaError) =>
        new InvalidReviewRouteInputError({
          offendingPath: input.changedFiles[0] ?? ReviewRawFileInput.make(""),
          reason: toErrorReasonMessage(schemaError),
        }),
    ),
  )

  const signals = yield* inferReviewDiffSignals(enrichedInput)
  const rawPlan = yield* routeReviewDiff(enrichedInput, signals)
  const escalatedPlan =
    manifestResult.warnings.length > 0 ? escalatePlanOnDiagnostics(rawPlan) : rawPlan
  const plan = attachReviewSlicesIfThresholdReached(signals, escalatedPlan)
  const reviewSlices = match(plan)
    .with({ _tag: "ActiveReviewPlan" }, (active) => active.reviewSlices)
    .with({ _tag: "SkipReviewPlan" }, () => undefined)
    .exhaustive()
  const graphContext = buildReviewGraphContextBundle(
    context?.repoRoot,
    context?.graph,
    signals.changedFiles,
  )

  return ReviewRouteToolOutput.make({
    plan,
    signals,
    graphContext,
    warnings: manifestResult.warnings,
    degraded: context?.graphStatus?.degraded ?? false,
    ...(reviewSlices !== undefined ? { reviewSlices } : {}),
    ...(context?.graphStatus?.degradedReason !== undefined
      ? { degradedReason: toErrorReasonMessage(context.graphStatus.degradedReason) }
      : {}),
    ...(context?.graphStatus?.evaluationError !== undefined
      ? { evaluationError: toErrorReasonMessage(context.graphStatus.evaluationError) }
      : {}),
  })
})

export const buildGraphNavigationToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_resolve"),
    description: "Resolve a symbol or span name to its node in the Effect graph",
    inputSchema: ResolveInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        return {
          node: resolveNode(graphStatus.graph, symbolOrSpan) ?? null,
          ...graphStatusMeta(graphStatus),
        }
      }),
  },
  {
    name: McpToolName.make("harness_callers"),
    description: "Find callers of an Effect function, service, or layer",
    inputSchema: CallersInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        return {
          callers: findCallers(graphStatus.graph, symbolOrSpan),
          ...graphStatusMeta(graphStatus),
        }
      }),
  },
  {
    name: McpToolName.make("harness_callees"),
    description: "Find callees of an Effect function, service, or layer",
    inputSchema: CalleesInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        return {
          callees: findCallees(graphStatus.graph, symbolOrSpan),
          ...graphStatusMeta(graphStatus),
        }
      }),
  },
  {
    name: McpToolName.make("harness_tests_reaching"),
    description: "Find all Vitest test cases reaching a given symbol or span",
    inputSchema: TestsReachingInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeResolveInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        return {
          tests: findTestsReaching(graphStatus.graph, symbolOrSpan),
          ...graphStatusMeta(graphStatus),
        }
      }),
  },
  {
    name: McpToolName.make("harness_structural_search"),
    description: "Perform structural AST search using ast-grep across workspace TypeScript code",
    inputSchema: StructuralSearchInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const input = yield* decodeStructuralSearchInput(args)
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        return yield* decideStructuralSearch({
          pattern: input.pattern,
          repoRoot: root,
          filePath: input.filePath,
          paths: input.paths,
          subDirs: input.subDirs,
          hostIo: nodeSyncHostIo,
        })
      }),
  },
  {
    name: McpToolName.make("harness_route"),
    description:
      "Route an implementation plan step to an Effect idiom building block using local decision model",
    inputSchema: RouteInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { planStep } = yield* decodeRouteInput(args)
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const routedOpt = yield* routeStep(planStep).pipe(
          Effect.provide(decisionLayer),
          Effect.timeoutOption("1500 millis"),
          Effect.catchCause((cause) => {
            if (isPureInterruptCause(cause)) {
              return Effect.interrupt
            }
            process.stderr.write(`[harness-mcp] decision fallback: ${Cause.pretty(cause)}\n`)
            return Effect.succeedNone
          }),
        )
        let block: string = Option.getOrElse(routedOpt, () => "review")
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        if (block === "review") {
          const patternsDir = path.join(root, "agent-patterns")
          if (nodeSyncHostIo.existsSync(patternsDir)) {
            const files = nodeSyncHostIo.readdirSync(patternsDir).map((entry) => entry.name)
            const stepLower = planStep.toLowerCase()
            const candidates = files
              .filter((f: string) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
              .map((f: string) => f.replace(/\.md$/, ""))
              .sort((a: string, b: string) => b.length - a.length)
            for (const slug of candidates) {
              const words = slug.split("-").filter((w: string) => w.length > 0)
              if (words.length > 0 && words.every((w: string) => stepLower.includes(w))) {
                block = slug
                break
              }
            }
          }
        }
        const patternFile =
          block === "review" || block === "effect" ? null : `agent-patterns/${block}.md`
        return { block, patternFile }
      }),
  },
  {
    name: McpToolName.make("harness_review_route"),
    description:
      "Route a code diff to required review depth, specialist reviewers, and Effect graph context",
    inputSchema: ReviewRouteInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const parsed = yield* decodeReviewRouteInput(args)
        const boundaryRoot = options?.repoRoot ?? resolveDefaultRepoRoot(undefined, options)
        if (parsed.repoRoot !== undefined && !isPathInsideRoot(boundaryRoot, parsed.repoRoot)) {
          return yield* new ProjectPathEscapeError({
            projectPath: parsed.repoRoot,
            repoRoot: boundaryRoot,
            message: "repoRoot escapes configured workspace root",
          })
        }
        const effectiveRoot =
          parsed.repoRoot !== undefined
            ? path.isAbsolute(parsed.repoRoot)
              ? path.resolve(parsed.repoRoot)
              : path.resolve(boundaryRoot, parsed.repoRoot)
            : boundaryRoot
        const effectiveTimeoutMs = resolveReviewRouteTimeoutMs(parsed.timeoutMs, options)
        const rawInput = yield* Schema.decodeEffect(ReviewRawDiffInput)({
          changedFiles: parsed.changedFiles,
          diffSummary: parsed.diffSummary ?? "",
          changedLineCount: parsed.changedLineCount,
          touchedTiers: parsed.touchedTiers ?? [],
          touchedScopes: parsed.touchedScopes ?? [],
          ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
          ...(parsed.remediationContext !== undefined
            ? { remediationContext: parsed.remediationContext }
            : {}),
        })
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const graphStatus = yield* resolveGraphWithStatus(
          { ...options, repoRoot: effectiveRoot },
          args,
        )
        return yield* executeReviewRouteTool(rawInput, {
          repoRoot: effectiveRoot,
          graph: graphStatus.graph,
          graphStatus,
        }).pipe(Effect.provide(decisionLayer))
      }),
  },
]
