import * as path from "node:path"
import { Cause, Effect, Graph, Option, Schema } from "effect"
import type * as DecisionModel from "effect/ai/DecisionModel"
import { match, P } from "ts-pattern"
import {
  EnclosingSymbolName,
  InvalidReviewRouteInputError,
  NxScopeTag,
  NxTierTag,
  ReviewChangedLines,
  ReviewGraphContextBundle,
  ReviewRawDiffInput,
  ReviewRawFileInput,
  ReviewRouteToolOutput,
  ReviewSignalPath,
  ReviewSummaryText,
  isPureInterruptCause,
  parseManifestTags,
} from "@harness/contract"
import {
  type HarnessGraph,
  decideStructuralSearch,
  findCallees,
  findCallers,
  findTestsReaching,
  resolveNode,
} from "@harness/graph"
import { inferReviewDiffSignals, routeReviewDiff, routeStep } from "@harness/decision"
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

export { isPathInsideRoot, normalizeProjectPath, resolveDefaultRepoRoot }

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

const ReviewRouteInputSchema = Schema.Struct({
  changedFiles: Schema.Array(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512))))
    .pipe(Schema.check(Schema.isMaxLength(200)))
    .annotate({
      description: "Changed workspace file paths in the diff",
    }),
  diffSummary: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(4096))).annotate({
      description: "Optional bounded diff summary text",
    }),
  ),
  changedLineCount: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
      description: "Optional non-negative count of changed lines",
    }),
  ),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const decodeResolveInput = Schema.decodeUnknownEffect(ResolveInputSchema)
const decodeStructuralSearchInput = Schema.decodeUnknownEffect(StructuralSearchInputSchema)
const decodeRouteInput = Schema.decodeUnknownEffect(RouteInputSchema)
const decodeReviewRouteInput = Schema.decodeUnknownEffect(ReviewRouteInputSchema)

const ManifestTagsSchema = Schema.Struct({
  tags: Schema.optional(Schema.Array(Schema.String)),
  nx: Schema.optional(
    Schema.Struct({
      tags: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestTagsSchema))

const decodeEnclosingSymbol = Schema.decodeUnknownOption(EnclosingSymbolName)
const decodeReviewSignalPath = Schema.decodeUnknownOption(ReviewSignalPath)

const addDecodedSymbol = (target: Set<EnclosingSymbolName>, raw: string, max: number): void => {
  if (target.size >= max) return
  match(decodeEnclosingSymbol(raw.trim()))
    .with({ _tag: "Some" }, ({ value }) => {
      target.add(value)
    })
    .with({ _tag: "None" }, () => {})
    .exhaustive()
}

const addDecodedSignalPath = (target: Set<ReviewSignalPath>, raw: string, max: number): void => {
  if (target.size >= max) return
  match(decodeReviewSignalPath(raw.trim()))
    .with({ _tag: "Some" }, ({ value }) => {
      target.add(value)
    })
    .with({ _tag: "None" }, () => {})
    .exhaustive()
}

const collectManifestTagsForFiles = (
  repoRoot: string,
  changedFiles: ReadonlyArray<ReviewSignalPath>,
): Effect.Effect<{
  readonly tiers: ReadonlyArray<NxTierTag>
  readonly scopes: ReadonlyArray<NxScopeTag>
}> =>
  Effect.gen(function* () {
    const tiers = new Set<NxTierTag>()
    const scopes = new Set<NxScopeTag>()
    const visitedDirs = new Set<string>()
    const resolvedRoot = path.resolve(repoRoot)

    for (const relFile of changedFiles) {
      let currDir = path.dirname(path.resolve(resolvedRoot, relFile))
      while (isPathInsideRoot(resolvedRoot, currDir) && currDir !== resolvedRoot) {
        if (visitedDirs.has(currDir)) {
          break
        }
        visitedDirs.add(currDir)

        for (const manifestName of ["project.json", "package.json"] as const) {
          const manifestPath = path.join(currDir, manifestName)
          if (isPathInsideRoot(resolvedRoot, manifestPath) && nodeSyncHostIo.existsSync(manifestPath)) {
            const rawText = yield* Effect.try(() =>
              nodeSyncHostIo.readTextSync(manifestPath),
            ).pipe(Effect.orElseSucceed(() => ""))
            if (rawText.length > 0) {
              const decoded = yield* decodeManifestJson(rawText).pipe(
                Effect.orElseSucceed(() => ({ tags: undefined, nx: undefined })),
              )
              const candidateTags = [
                ...(decoded.tags ?? []),
                ...(decoded.nx?.tags ?? []),
              ]
              if (candidateTags.length > 0) {
                const parsed = parseManifestTags(candidateTags)
                for (const t of parsed.nxTags) tiers.add(t)
                for (const s of parsed.scopeTags) scopes.add(s)
              }
            }
          }
        }
        currDir = path.dirname(currDir)
      }
    }

    return {
      tiers: [...tiers],
      scopes: [...scopes],
    }
  })

const normalizeGraphFile = (repoRoot: string | undefined, filePath: string): string => {
  const normalized = filePath.replaceAll("\\", "/")
  if (repoRoot === undefined) {
    return normalized
  }
  const resolvedRoot = path.resolve(repoRoot).replaceAll("\\", "/")
  return normalized.startsWith(`${resolvedRoot}/`)
    ? normalized.slice(resolvedRoot.length + 1)
    : normalized
}

const buildReviewGraphContextBundle = (
  repoRoot: string | undefined,
  harnessGraph: HarnessGraph | undefined,
  changedFiles: ReadonlyArray<ReviewSignalPath>,
): ReviewGraphContextBundle => {
  if (harnessGraph === undefined || changedFiles.length === 0) {
    return ReviewGraphContextBundle.make({
      touchedSymbols: [],
      reachingTests: [],
      governanceRefs: [],
    })
  }

  const changedSet = new Set<string>(changedFiles)
  const touchedSymbolsSet = new Set<EnclosingSymbolName>()
  const governanceRefsSet = new Set<ReviewSignalPath>()

  for (const [, node] of Graph.nodes(harnessGraph.graph)) {
    match(node)
      .with({ _tag: "EffectFn" }, (fnNode) => {
        const rel = normalizeGraphFile(repoRoot, fnNode.file)
        if (changedSet.has(rel)) {
          addDecodedSymbol(
            touchedSymbolsSet,
            fnNode.spanName.length > 0 ? fnNode.spanName : fnNode.qualname,
            50,
          )
        }
      })
      .with({ _tag: "ServiceTag" }, (svcNode) => {
        const rel = normalizeGraphFile(repoRoot, svcNode.file)
        if (changedSet.has(rel)) {
          addDecodedSymbol(touchedSymbolsSet, svcNode.name, 50)
        }
      })
      .with({ _tag: "ServiceLayer" }, (layerNode) => {
        const rel = normalizeGraphFile(repoRoot, layerNode.file)
        if (changedSet.has(rel)) {
          addDecodedSymbol(touchedSymbolsSet, layerNode.qualname, 50)
        }
      })
      .with({ _tag: "TaggedError" }, (errNode) => {
        const rel = normalizeGraphFile(repoRoot, errNode.file)
        if (changedSet.has(rel)) {
          addDecodedSymbol(touchedSymbolsSet, errNode.errorTag, 50)
        }
      })
      .with({ _tag: "AdrDoc" }, (adrNode) => {
        const relDoc = normalizeGraphFile(repoRoot, adrNode.path)
        const enforcedMatch = adrNode.enforcedByFiles.some((e) =>
          changedSet.has(normalizeGraphFile(repoRoot, e)),
        )
        if (enforcedMatch || changedSet.has(relDoc)) {
          addDecodedSignalPath(governanceRefsSet, relDoc, 30)
        }
      })
      .with({ _tag: "EarsSpec" }, (specNode) => {
        const relDoc = normalizeGraphFile(repoRoot, specNode.path)
        const enforcedMatch = specNode.enforcedByFiles.some((e) =>
          changedSet.has(normalizeGraphFile(repoRoot, e)),
        )
        if (enforcedMatch || changedSet.has(relDoc)) {
          addDecodedSignalPath(governanceRefsSet, relDoc, 30)
        }
      })
      .with(
        {
          _tag: P.union(
            "SchemaDef",
            "VitestCase",
            "PatternDoc",
            "EffectSignature",
            "LayerFlow",
            "TraceabilityTuple",
            "HttpEndpointTuple",
            "MigrationTuple",
          ),
        },
        () => {},
      )
      .exhaustive()
  }

  const touchedSymbols = [...touchedSymbolsSet]
  const reachingTestsSet = new Set<EnclosingSymbolName>()
  for (const sym of touchedSymbols.slice(0, 20)) {
    for (const testCase of findTestsReaching(harnessGraph, sym)) {
      if (reachingTestsSet.size >= 50) break
      addDecodedSymbol(
        reachingTestsSet,
        testCase.testName.length > 0 ? testCase.testName : (testCase.file ?? ""),
        50,
      )
    }
  }

  return ReviewGraphContextBundle.make({
    touchedSymbols,
    reachingTests: [...reachingTestsSet],
    governanceRefs: [...governanceRefsSet],
  })
}

export interface ReviewRouteExecutionContext {
  readonly repoRoot?: string | undefined
  readonly graph?: HarnessGraph | undefined
}

export const executeReviewRouteTool = Effect.fn("HarnessMcp.routeReview")(function* (
  input: ReviewRawDiffInput,
  context?: ReviewRouteExecutionContext,
): Effect.fn.Return<
  ReviewRouteToolOutput,
  InvalidReviewRouteInputError,
  DecisionModel.DecisionModel
> {
  const initialSignals = yield* inferReviewDiffSignals(input)

  const manifestTags =
    context?.repoRoot !== undefined && nodeSyncHostIo.existsSync(context.repoRoot)
      ? yield* collectManifestTagsForFiles(context.repoRoot, initialSignals.changedFiles)
      : { tiers: [] as ReadonlyArray<NxTierTag>, scopes: [] as ReadonlyArray<NxScopeTag> }

  const mergedTiers = [...new Set([...input.touchedTiers, ...manifestTags.tiers])]
  const mergedScopes = [...new Set([...input.touchedScopes, ...manifestTags.scopes])]

  const enrichedInput = ReviewRawDiffInput.make({
    ...input,
    touchedTiers: mergedTiers,
    touchedScopes: mergedScopes,
  })

  const signals = yield* inferReviewDiffSignals(enrichedInput)
  const plan = yield* routeReviewDiff(enrichedInput)
  const graphContext = buildReviewGraphContextBundle(
    context?.repoRoot,
    context?.graph,
    signals.changedFiles,
  )

  return ReviewRouteToolOutput.make({
    plan,
    signals,
    graphContext,
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
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        if (
          options?.repoRoot !== undefined &&
          parsed.repoRoot !== undefined &&
          !isPathInsideRoot(options.repoRoot, parsed.repoRoot)
        ) {
          return yield* new ProjectPathEscapeError({
            projectPath: parsed.repoRoot,
            repoRoot: options.repoRoot,
            message: "repoRoot escapes configured workspace root",
          })
        }
        const rawInput = ReviewRawDiffInput.make({
          changedFiles: parsed.changedFiles.map((filePath) => ReviewRawFileInput.make(filePath)),
          diffSummary: ReviewSummaryText.make(parsed.diffSummary ?? ""),
          changedLineCount: ReviewChangedLines.make(parsed.changedLineCount ?? 0),
          touchedTiers: [],
          touchedScopes: [],
        })
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        return yield* executeReviewRouteTool(rawInput, {
          repoRoot: root,
          graph: graphStatus.graph,
        }).pipe(
          Effect.provide(decisionLayer),
          Effect.catchTag("InvalidReviewRouteInputError", (err) =>
            new ProjectPathEscapeError({
              projectPath: err.offendingPath,
              repoRoot: root,
              message: err.reason,
            }),
          ),
        )
      }),
  },
]
