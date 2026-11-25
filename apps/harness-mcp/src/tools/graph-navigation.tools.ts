import * as path from "node:path"
import { Cause, Effect, Option, Schema } from "effect"
import type * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  ErrorReasonMessage,
  InvalidReviewRouteInputError,
  KnowledgeQueryText,
  type NxScopeTag,
  type NxTierTag,
  ReviewChangedLines,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRouteToolOutput,
  type WorkflowStoreUnavailableError,
  isPureInterruptCause,
  toErrorReasonMessage,
} from "@harness/contract"
import {
  decideStructuralSearch,
  executeNamedGqQueryInMemory,
  findCallees,
  findCallers,
  findTestsReaching,
  invokeOmnigraphNamedQuery,
  makeOmnigraphSyncLayer,
  resolveNode,
  scoreLexicalBm25Lite,
  tokenizeRetrievalText,
} from "@harness/graph"
import {
  attachReviewSlicesIfThresholdReached,
  inferReviewDiffSignals,
  normalizeReviewFilePaths,
  routeReviewDiff,
  routeStepWithStatus,
  selectRouteWithHybridCandidates,
} from "@harness/decision"
import { EmbeddingClient } from "@harness/service"
import { LocalDecisionModel, nodeSyncHostIo, OllamaEmbeddingClientLive } from "@harness/infra"
import {
  graphStatusMeta,
  hasIntermediateRepoBoundary,
  isPathInsideRoot,
  McpToolName,
  type McpToolPluginDescriptor,
  normalizeProjectPath,
  ProjectPathEscapeError,
  resolveContainedRepoRoot,
  resolveDefaultRepoRoot,
  resolveGraphWithStatus,
  type ServerOptions,
} from "./mcp-helpers.js"
import {
  buildReviewGraphContextBundle,
  collectManifestTagsForFiles,
  decodeReviewRouteInput,
  deriveChangedLineCountFromGit,
  escalatePlanOnDiagnostics,
  resolveReviewRouteTimeoutMs,
  type ReviewRouteExecutionContext,
  ReviewRouteInputSchema,
  type ReviewRouteToolInput,
} from "./review-route-helpers.js"
import { graphHasNodesForKind } from "./retrieval-search-helpers.js"

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
  input: ReviewRouteToolInput,
  context?: ReviewRouteExecutionContext,
): Effect.fn.Return<
  ReviewRouteToolOutput,
  InvalidReviewRouteInputError,
  DecisionModel.DecisionModel
> {
  const mapRouteInputError = (schemaError: unknown): InvalidReviewRouteInputError => {
    const firstFile = Array.isArray(input?.changedFiles) ? input.changedFiles[0] : undefined
    return new InvalidReviewRouteInputError({
      offendingPath: match(Schema.decodeUnknownOption(ReviewRawFileInput)(firstFile))
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => ReviewRawFileInput.make("unknown"))
        .exhaustive(),
      reason: toErrorReasonMessage(schemaError),
    })
  }

  const toInvalidRepoRootError = (
    rawRepoRoot: string,
    err: ProjectPathEscapeError | WorkflowStoreUnavailableError,
  ): InvalidReviewRouteInputError =>
    new InvalidReviewRouteInputError({
      offendingPath: match(Schema.decodeOption(ReviewRawFileInput)(rawRepoRoot.slice(0, 512)))
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => ReviewRawFileInput.make("repoRoot"))
        .exhaustive(),
      reason: toErrorReasonMessage(
        match(err)
          .with({ _tag: "ProjectPathEscapeError" }, (e) => e.message)
          .with({ _tag: "WorkflowStoreUnavailableError" }, (e) => e.reason)
          .exhaustive(),
      ),
    })

  const parsed = yield* decodeReviewRouteInput(input).pipe(Effect.mapError(mapRouteInputError))
  const normalizedFiles = yield* normalizeReviewFilePaths(
    parsed.changedFiles.map((f) => ReviewRawFileInput.make(f)),
  )

  const requestedRepoRoot = parsed.repoRoot
  const effectiveRepoRoot =
    context?.repoRoot !== undefined
      ? context.repoRoot
      : requestedRepoRoot !== undefined
        ? yield* resolveContainedRepoRoot(requestedRepoRoot).pipe(
            Effect.mapError((err) => toInvalidRepoRootError(requestedRepoRoot, err)),
          )
        : undefined

  const manifestResult = yield* Effect.gen(function* () {
    if (effectiveRepoRoot === undefined) {
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
    if (!nodeSyncHostIo.existsSync(effectiveRepoRoot)) {
      return {
        tiers: [] as ReadonlyArray<NxTierTag>,
        scopes: [] as ReadonlyArray<NxScopeTag>,
        warnings: [
          toErrorReasonMessage(`Configured repoRoot does not exist on disk: ${effectiveRepoRoot}`),
        ] as ReadonlyArray<ErrorReasonMessage>,
      }
    }
    return yield* collectManifestTagsForFiles(effectiveRepoRoot, normalizedFiles)
  })

  const derivedLineResult =
    parsed.changedLineCount !== undefined
      ? { changedLineCount: parsed.changedLineCount, warning: undefined }
      : effectiveRepoRoot !== undefined
        ? yield* deriveChangedLineCountFromGit(effectiveRepoRoot, normalizedFiles, parsed.baseRef)
        : {
            changedLineCount: ReviewChangedLines.make(0),
            warning: ErrorReasonMessage.make(
              "No repoRoot supplied; changedLineCount auto-derivation unavailable",
            ),
          }

  const allWarnings = [
    ...manifestResult.warnings,
    ...(derivedLineResult.warning !== undefined ? [derivedLineResult.warning] : []),
  ]
  const mergedTiers = [...new Set([...(parsed.touchedTiers ?? []), ...manifestResult.tiers])]
  const mergedScopes = [...new Set([...(parsed.touchedScopes ?? []), ...manifestResult.scopes])]

  const enrichedInput = yield* Schema.decodeEffect(ReviewRawDiffInput)({
    changedFiles: normalizedFiles,
    diffSummary: parsed.diffSummary ?? "",
    changedLineCount: derivedLineResult.changedLineCount,
    touchedTiers: mergedTiers,
    touchedScopes: mergedScopes,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.remediationContext !== undefined
      ? { remediationContext: parsed.remediationContext }
      : {}),
  }).pipe(Effect.mapError(mapRouteInputError))

  const signals = yield* inferReviewDiffSignals(enrichedInput)
  const rawPlan = yield* routeReviewDiff(enrichedInput, signals)
  const escalatedPlan = allWarnings.length > 0 ? escalatePlanOnDiagnostics(rawPlan) : rawPlan
  const plan = attachReviewSlicesIfThresholdReached(signals, escalatedPlan)
  const reviewSlices = match(plan)
    .with({ _tag: "ActiveReviewPlan" }, (active) => active.reviewSlices)
    .with({ _tag: "SkipReviewPlan" }, () => undefined)
    .exhaustive()
  const graphContext = buildReviewGraphContextBundle(
    effectiveRepoRoot,
    context?.graph,
    signals.changedFiles,
  )

  const planDegradedReason = plan.degradedReason
  const isDegraded = (context?.graphStatus?.degraded ?? false) || planDegradedReason !== undefined
  const combinedDegradedReason =
    [context?.graphStatus?.degradedReason, planDegradedReason]
      .filter((v): v is string => v !== undefined && v.length > 0)
      .join("; ") || undefined

  return ReviewRouteToolOutput.make({
    plan,
    signals,
    graphContext,
    warnings: allWarnings,
    degraded: isDegraded,
    ...(reviewSlices !== undefined ? { reviewSlices } : {}),
    ...(combinedDegradedReason !== undefined
      ? { degradedReason: toErrorReasonMessage(combinedDegradedReason) }
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
        const { symbolOrSpan, repoRoot } = yield* decodeResolveInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
        const node = resolveNode(graphStatus.graph, symbolOrSpan) ?? null
        const suggestions =
          node === null
            ? executeNamedGqQueryInMemory(graphStatus.graph, "resolve_effect_fn_fuzzy", {
                query: symbolOrSpan,
              }).slice(0, 5)
            : undefined
        return {
          node,
          ...(suggestions !== undefined ? { suggestions } : {}),
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
        const { symbolOrSpan, repoRoot } = yield* decodeResolveInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
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
        const { symbolOrSpan, repoRoot } = yield* decodeResolveInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
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
        const { symbolOrSpan, repoRoot } = yield* decodeResolveInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
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
        const root = yield* resolveContainedRepoRoot(input.repoRoot, options)
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
      "Route an implementation plan step to an Effect idiom building block using hybrid Omnigraph pattern retrieval and local decision model",
    inputSchema: RouteInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { planStep, repoRoot } = yield* decodeRouteInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
        const routedOpt = yield* routeStepWithStatus(planStep).pipe(
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
        const baseRoute = Option.getOrElse(routedOpt, () => ({
          block: "review" as const,
          source: "degraded-fallback" as const,
        }))

        const syncLayer = options?.omnigraphSyncLayer ?? makeOmnigraphSyncLayer(nodeSyncHostIo)
        const embeddingLayer = options?.embeddingClientLayer ?? OllamaEmbeddingClientLive
        const skipOmnigraph =
          (options?.skipOmnigraphSpawn === true ||
            (options?.graph !== undefined && options?.skipOmnigraphSpawn !== false)) &&
          !process.env["OMNIGRAPH_URL"] &&
          options?.omnigraphSyncLayer === undefined

        const trimmedStep = planStep.trim()
        const shouldProbeEmbeddings =
          trimmedStep.length > 0 && (!skipOmnigraph || options?.embeddingClientLayer !== undefined)
        const queryVectorOpt: Option.Option<ReadonlyArray<number>> = shouldProbeEmbeddings
          ? yield* Effect.gen(function* () {
              const client = yield* EmbeddingClient
              const avail = yield* client.checkAvailability
              return yield* match(avail)
                .with({ _tag: "Available" }, () =>
                  client.embedQuery(KnowledgeQueryText.make(trimmedStep)).pipe(
                    Effect.map((vec): ReadonlyArray<number> => vec.components),
                    Effect.asSome,
                  ),
                )
                .with({ _tag: "Unavailable" }, () => Effect.succeedNone)
                .exhaustive()
            }).pipe(
              Effect.provide(embeddingLayer),
              Effect.orElseSucceed(() => Option.none<ReadonlyArray<number>>()),
            )
          : Option.none<ReadonlyArray<number>>()

        const runRoutePatternQuery = (
          queryName: "rank_patterns_vector_hybrid" | "rank_patterns_bm25",
          queryParams: Readonly<Record<string, unknown>>,
        ) =>
          invokeOmnigraphNamedQuery({
            repoRoot: root,
            actor: "agent-mcp",
            name: queryName,
            params: queryParams,
            fallbackGraph: graphStatus.graph,
            ...(skipOmnigraph ? { baseUrl: "http://127.0.0.1:1" } : {}),
          }).pipe(
            Effect.provide(syncLayer),
            Effect.catch((err) =>
              Effect.succeed({
                source: "memory-fallback" as const,
                rows: executeNamedGqQueryInMemory(graphStatus.graph, queryName, queryParams),
                degraded: true as const,
                fallbackError: toErrorReasonMessage(err, "fallback"),
              }),
            ),
          )

        interface RouteCandidateQueryOutcome {
          readonly rows: ReadonlyArray<Record<string, unknown>>
          readonly usedLiveVectorHybrid: boolean
        }

        const runBm25FallbackRows = (): Effect.Effect<RouteCandidateQueryOutcome> =>
          runRoutePatternQuery("rank_patterns_bm25", {
            query: trimmedStep,
            targetLayer: "*",
          }).pipe(Effect.map((res) => ({ rows: res.rows, usedLiveVectorHybrid: false })))

        const candidateQueryOutcome: RouteCandidateQueryOutcome = yield* match(queryVectorOpt)
          .with({ _tag: "Some" }, ({ value: vectorQuery }) =>
            runRoutePatternQuery("rank_patterns_vector_hybrid", {
              vectorQuery: [...vectorQuery],
              textQuery: trimmedStep,
              targetLayer: "*",
            }).pipe(
              Effect.flatMap((res) =>
                match(res)
                  .with({ source: "omnigraph" }, ({ rows }) => {
                    if (rows.length > 0) {
                      return Effect.succeed<RouteCandidateQueryOutcome>({
                        rows,
                        usedLiveVectorHybrid: true,
                      })
                    }
                    if (graphHasNodesForKind(graphStatus.graph, "PatternDoc", "*")) {
                      return runBm25FallbackRows()
                    }
                    return Effect.succeed<RouteCandidateQueryOutcome>({
                      rows: [],
                      usedLiveVectorHybrid: false,
                    })
                  })
                  .with({ source: "memory-fallback" }, () => runBm25FallbackRows())
                  .exhaustive(),
              ),
            ),
          )
          .with({ _tag: "None" }, () => runBm25FallbackRows())
          .exhaustive()

        const hasMeaningfulTokens = tokenizeRetrievalText(trimmedStep).length > 0
        const candidatePatterns = candidateQueryOutcome.rows
          .filter((row) => typeof row["slug"] === "string")
          .map((row, idx) => {
            const slug = String(row["slug"])
            const titleStr = typeof row["title"] === "string" ? row["title"] : ""
            const summaryStr = typeof row["summary"] === "string" ? row["summary"] : ""
            const rowScore =
              typeof row["score"] === "number" && Number.isFinite(row["score"])
                ? row["score"]
                : undefined
            const computedScore = candidateQueryOutcome.usedLiveVectorHybrid
              ? (rowScore ?? (hasMeaningfulTokens ? 1 / (60 + idx) : 0))
              : (rowScore ??
                scoreLexicalBm25Lite(
                  `${slug} ${titleStr} ${summaryStr}`,
                  `${slug} ${titleStr}`,
                  trimmedStep,
                ))
            return {
              slug,
              path: typeof row["path"] === "string" ? row["path"] : undefined,
              score: computedScore,
              scoreKind: candidateQueryOutcome.usedLiveVectorHybrid
                ? ("rrf" as const)
                : ("bm25" as const),
            }
          })

        const combined = selectRouteWithHybridCandidates(baseRoute, candidatePatterns)
        let block: string = combined.block
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
        const isDecisionModelFallback = match(baseRoute.source)
          .with("degraded-fallback", () => true)
          .with("deterministic", () => false)
          .with("hybrid-retrieval", () => false)
          .with("model", () => false)
          .exhaustive()
        const routeDegraded = graphStatus.degraded || isDecisionModelFallback
        const routeDegradedReason = [
          graphStatus.degradedReason,
          isDecisionModelFallback ? "decision-model-fallback" : undefined,
        ]
          .filter((v): v is string => v !== undefined && v.length > 0)
          .join("; ")
        return {
          block,
          patternFile,
          source: combined.source,
          candidatePatterns: candidatePatterns.slice(0, 5).map((c) => c.slug),
          degraded: routeDegraded,
          ...(routeDegraded && routeDegradedReason.length > 0
            ? { degradedReason: routeDegradedReason }
            : {}),
          ...(graphStatus.evaluationError !== undefined
            ? { evaluationError: graphStatus.evaluationError }
            : {}),
        }
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
        const candidateRoot = yield* resolveContainedRepoRoot(parsed.repoRoot, options)
        const resolvedBoundary = path.resolve(boundaryRoot)
        const isStrictSubdirWithoutWorkspaceMarker =
          isPathInsideRoot(resolvedBoundary, candidateRoot) &&
          candidateRoot !== resolvedBoundary &&
          nodeSyncHostIo.existsSync(candidateRoot) &&
          nodeSyncHostIo.isDirectorySync(candidateRoot) &&
          !hasIntermediateRepoBoundary(resolvedBoundary, candidateRoot)
        let effectiveRoot = candidateRoot
        let effectiveChangedFiles: ReadonlyArray<string> = parsed.changedFiles
        if (isStrictSubdirWithoutWorkspaceMarker) {
          const relSubdir = path.relative(resolvedBoundary, candidateRoot).replaceAll("\\", "/")
          const validatedRelPaths = yield* normalizeReviewFilePaths(
            parsed.changedFiles.map((f) => ReviewRawFileInput.make(f)),
          )
          effectiveRoot = resolvedBoundary
          effectiveChangedFiles = validatedRelPaths.map((relPath) =>
            relPath.startsWith(`${relSubdir}/`) ? relPath : `${relSubdir}/${relPath}`,
          )
        }
        const effectiveTimeoutMs = resolveReviewRouteTimeoutMs(parsed.timeoutMs, options)
        const toolInput: ReviewRouteToolInput = {
          ...parsed,
          changedFiles: effectiveChangedFiles,
          ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}),
        }
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const graphStatus = yield* resolveGraphWithStatus(
          { ...options, repoRoot: effectiveRoot },
          args,
        )
        return yield* executeReviewRouteTool(toolInput, {
          repoRoot: effectiveRoot,
          graph: graphStatus.graph,
          graphStatus,
        }).pipe(Effect.provide(decisionLayer))
      }),
  },
]
