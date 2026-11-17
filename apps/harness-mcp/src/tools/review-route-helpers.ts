import * as path from "node:path"
import { Effect, Graph, Option, Schema } from "effect"
import { match, P } from "ts-pattern"
import {
  ActiveReviewPlan,
  EnclosingSymbolName,
  ErrorReasonMessage,
  NxScopeTag,
  NxTierTag,
  ReviewDepth,
  ReviewGraphContextBundle,
  type ReviewRoutingPlan,
  ReviewRoutingReason,
  ReviewSignalPath,
  ReviewTimeoutMillis,
  ReviewerId,
  ReviewerSelection,
  parseManifestTags,
  toErrorReasonMessage,
} from "@harness/contract"
import { type HarnessGraph, findTestsReaching } from "@harness/graph"
import { nodeSyncHostIo } from "@harness/infra"
import { type GraphResolutionStatus, isPathInsideRoot, type ServerOptions } from "./mcp-helpers.js"

const BoundedRepoRoot = Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 1024)))

export const ReviewRouteInputSchema = Schema.Struct({
  changedFiles: Schema.Array(Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512))))
    .pipe(Schema.check(Schema.isBetweenLength(1, 200)))
    .annotate({
      description: "Changed workspace file paths in the diff",
    }),
  diffSummary: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMaxLength(4096))).annotate({
      description: "Optional bounded diff summary text",
    }),
  ),
  changedLineCount: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Non-negative count of changed lines",
  }),
  touchedTiers: Schema.optional(
    Schema.Array(NxTierTag)
      .pipe(Schema.check(Schema.isMaxLength(16)))
      .annotate({
        description: "Optional caller-supplied Nx tier tags",
      }),
  ),
  touchedScopes: Schema.optional(
    Schema.Array(NxScopeTag)
      .pipe(Schema.check(Schema.isMaxLength(16)))
      .annotate({
        description: "Optional caller-supplied Nx scope tags",
      }),
  ),
  timeoutMs: Schema.optional(
    ReviewTimeoutMillis.annotate({
      description: "Optional DecisionModel timeout in milliseconds (100..30000)",
    }),
  ),
  repoRoot: Schema.optional(
    BoundedRepoRoot.annotate({
      description: "Optional repository root path",
    }),
  ),
})

export const decodeReviewRouteInput = Schema.decodeUnknownEffect(ReviewRouteInputSchema)

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

export const resolveReviewRouteTimeoutMs = (
  parsedTimeout: ReviewTimeoutMillis | undefined,
  options?: ServerOptions,
): ReviewTimeoutMillis | undefined => {
  if (parsedTimeout !== undefined) {
    return parsedTimeout
  }
  if (options?.reviewRouteTimeoutMs !== undefined) {
    return options.reviewRouteTimeoutMs
  }
  const rawEnv = process.env["HARNESS_REVIEW_ROUTE_TIMEOUT_MS"]
  if (rawEnv === undefined || rawEnv.trim().length === 0) {
    return undefined
  }
  const parsedEnv = Schema.decodeOption(ReviewTimeoutMillis)(Number(rawEnv))
  return Option.getOrUndefined(parsedEnv)
}

export const collectManifestTagsForFiles = (
  repoRoot: string,
  changedFiles: ReadonlyArray<ReviewSignalPath>,
): Effect.Effect<{
  readonly tiers: ReadonlyArray<NxTierTag>
  readonly scopes: ReadonlyArray<NxScopeTag>
  readonly warnings: ReadonlyArray<ErrorReasonMessage>
}> =>
  Effect.gen(function* () {
    const tiers = new Set<NxTierTag>()
    const scopes = new Set<NxScopeTag>()
    const warnings: Array<ErrorReasonMessage> = []
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
            const relManifest = path.relative(resolvedRoot, manifestPath).replaceAll("\\", "/")
            const readOutcome = yield* Effect.try(() =>
              nodeSyncHostIo.readTextSync(manifestPath),
            ).pipe(
              Effect.map((text) => ({ _tag: "ReadOk" as const, text })),
              Effect.catch((err) => Effect.succeed({ _tag: "ReadErr" as const, err })),
            )

            const rawText = match(readOutcome)
              .with({ _tag: "ReadErr" }, ({ err }) => {
                warnings.push(
                  toErrorReasonMessage(
                    `Failed to read manifest "${relManifest}": ${toErrorReasonMessage(err)}`,
                  ),
                )
                return undefined
              })
              .with({ _tag: "ReadOk" }, ({ text }) => text)
              .exhaustive()

            if (rawText !== undefined) {
              const parseOutcome = yield* decodeManifestJson(rawText).pipe(
                Effect.map((decoded) => ({ _tag: "DecodeOk" as const, decoded })),
                Effect.catch((err) => Effect.succeed({ _tag: "DecodeErr" as const, err })),
              )
              match(parseOutcome)
                .with({ _tag: "DecodeErr" }, ({ err }) => {
                  warnings.push(
                    toErrorReasonMessage(
                      `Failed to parse manifest "${relManifest}": ${toErrorReasonMessage(err)}`,
                    ),
                  )
                })
                .with({ _tag: "DecodeOk" }, ({ decoded }) => {
                  const candidateTags = [
                    ...(decoded.tags ?? []),
                    ...(decoded.nx?.tags ?? []),
                  ]
                  if (candidateTags.length > 0) {
                    const parsed = parseManifestTags(candidateTags)
                    for (const t of parsed.nxTags) tiers.add(t)
                    for (const s of parsed.scopeTags) scopes.add(s)
                    if (parsed.unknownTags.length > 0) {
                      warnings.push(
                        toErrorReasonMessage(
                          `Unrecognized Nx tags in "${relManifest}": ${parsed.unknownTags.join(", ")}`,
                        ),
                      )
                    }
                  }
                })
                .exhaustive()
            }
          }
        }
        currDir = path.dirname(currDir)
      }
    }

    return {
      tiers: [...tiers],
      scopes: [...scopes],
      warnings,
    }
  })

const DIAGNOSTIC_ARCH_REVIEWER_REASON = ReviewRoutingReason.make(
  "Workspace or manifest diagnostic warning requires focused architecture review",
)

export const escalatePlanOnDiagnostics = (plan: ReviewRoutingPlan): ReviewRoutingPlan => {
  const archReviewer = ReviewerId.make("effect-architecture-reviewer")
  return match(plan)
    .with({ _tag: "SkipReviewPlan" }, (skip) =>
      ActiveReviewPlan.make({
        depth: ReviewDepth.make("focused"),
        source: skip.source,
        ...(skip.degradedReason !== undefined ? { degradedReason: skip.degradedReason } : {}),
        selections: [
          ReviewerSelection.make({
            reviewer: archReviewer,
            reason: DIAGNOSTIC_ARCH_REVIEWER_REASON,
            mandatory: true,
          }),
        ],
      }),
    )
    .with({ _tag: "ActiveReviewPlan" }, (active) => {
      const hasArch = active.selections.some((sel) => sel.reviewer === archReviewer)
      const nextSelections: readonly [ReviewerSelection, ...Array<ReviewerSelection>] = hasArch
        ? active.selections
        : [
            active.selections[0],
            ...active.selections.slice(1),
            ReviewerSelection.make({
              reviewer: archReviewer,
              reason: DIAGNOSTIC_ARCH_REVIEWER_REASON,
              mandatory: true,
            }),
          ]
      const nextDepth =
        nextSelections.length >= 3
          ? ReviewDepth.make("full")
          : active.depth === "lite"
            ? ReviewDepth.make("focused")
            : active.depth
      return ActiveReviewPlan.make({
        depth: nextDepth,
        source: active.source,
        ...(active.degradedReason !== undefined ? { degradedReason: active.degradedReason } : {}),
        selections: nextSelections,
      })
    })
    .exhaustive()
}

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

export const buildReviewGraphContextBundle = (
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
  readonly graphStatus?: GraphResolutionStatus | undefined
}
