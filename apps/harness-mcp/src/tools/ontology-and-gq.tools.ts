import * as Graph from "effect/Graph"
import { Cause, Effect, Layer, Schema } from "effect"
import { match } from "ts-pattern"
import {
  ConflictPairLimit,
  EarsClauseText,
  EarsEffectSymbol,
  EmbeddingComponent,
  EmbeddingNodeKey,
  GovernanceDocIdentifier,
  isPureInterruptCause,
  type RequirementEmbeddingItem,
  RequirementId,
  SimilarityScore,
  WorkspaceFilePath,
} from "@harness/contract"
import {
  HARNESS_GQ_QUERY_NAMES,
  type HarnessGraph,
  invokeOmnigraphNamedQuery,
  makeOmnigraphSyncLayer,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
  syncGraphEmbeddings,
} from "@harness/graph"
import {
  decideOntologyInvariants,
  decideSemanticConflictPairs,
  evaluateOntologyConflictsWithStatus,
  extractOntologyConflictPairs,
  type OntologyConflictEvaluationReport,
  type OntologyConflictInput,
} from "@harness/decision"
import {
  decideEmbeddingSyncPlan,
  type GovernanceDocReference,
  loadGovernanceDocsChecked,
} from "@harness/gates"
import {
  FileEmbeddingCacheLive,
  LocalDecisionModel,
  nodeSyncHostIo,
  OllamaEmbeddingClientLive,
} from "@harness/infra"
import {
  graphStatusMeta,
  McpToolName,
  type McpToolPluginDescriptor,
  resolveDefaultRepoRoot,
  resolveGraphWithStatus,
  type ServerOptions,
} from "./mcp-helpers.js"

const BoundedNonEmptyString = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isTrimmed()), Schema.check(Schema.isBetweenLength(1, max)))

const BoundedParamsRecord = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.check(Schema.isPropertyNames(BoundedNonEmptyString(128))),
  Schema.check(Schema.isMaxProperties(64)),
)

export const OntologyWhyInputSchema = Schema.Struct({
  symbolOrSpan: BoundedNonEmptyString(512).annotate({
    description:
      "Symbol, service, layer, error, or span name to trace upward to Motivation (EARS & ADR)",
  }),
  repoRoot: Schema.optional(
    BoundedNonEmptyString(1024).annotate({
      description: "Optional repository root path",
    }),
  ),
})

export const OntologyImpactInputSchema = Schema.Struct({
  symbolOrSpan: BoundedNonEmptyString(512).annotate({
    description:
      "Symbol, service, layer, error, or span name to analyze cross-layer ArchiMate impact for",
  }),
  repoRoot: Schema.optional(
    BoundedNonEmptyString(1024).annotate({
      description: "Optional repository root path",
    }),
  ),
})

export const OntologyCheckInputSchema = Schema.Struct({
  scope: Schema.optional(
    BoundedNonEmptyString(128).annotate({
      description:
        "Optional scope name (e.g. 'sample') to check deterministic cross-layer invariants and Clef semantic conflicts",
    }),
  ),
  repoRoot: Schema.optional(
    BoundedNonEmptyString(1024).annotate({
      description: "Optional repository root path",
    }),
  ),
})

export const GqQueryInputSchema = Schema.Struct({
  queryName: Schema.Literals(HARNESS_GQ_QUERY_NAMES).annotate({
    description: "Name of the canonical .gq query in libs/harness/graph/queries/harness.gq",
  }),
  params: Schema.optional(
    BoundedParamsRecord.annotate({
      description: "Query parameters matching $var placeholders",
    }),
  ),
  branch: Schema.optional(
    BoundedNonEmptyString(256).annotate({
      description: "Target graph branch (defaults to 'main')",
    }),
  ),
  repoRoot: Schema.optional(
    BoundedNonEmptyString(1024).annotate({
      description: "Target repository root for cluster resolution",
    }),
  ),
})

const decodeOntologyWhyInput = Schema.decodeUnknownEffect(OntologyWhyInputSchema)
const decodeOntologyImpactInput = Schema.decodeUnknownEffect(OntologyImpactInputSchema)
const decodeOntologyCheckInput = Schema.decodeUnknownEffect(OntologyCheckInputSchema)
const decodeGqQueryInput = Schema.decodeUnknownEffect(GqQueryInputSchema)

const collectMcpSemanticConflictPairs = (
  repoRoot: string,
  graph: HarnessGraph,
  docs: ReadonlyArray<GovernanceDocReference>,
  existingPairs: ReadonlyArray<OntologyConflictInput>,
  options?: ServerOptions,
): Effect.Effect<ReadonlyArray<OntologyConflictInput>> =>
  Effect.gen(function* () {
    if (
      docs.length === 0 ||
      (options?.skipOmnigraphSpawn === true && options?.embeddingClientLayer === undefined)
    ) {
      return []
    }
    const embeddingLayer = options?.embeddingClientLayer ?? OllamaEmbeddingClientLive
    const vectors = yield* syncGraphEmbeddings({
      graph,
      repoRoot: WorkspaceFilePath.make(repoRoot),
      decidePlan: decideEmbeddingSyncPlan,
    }).pipe(
      Effect.provide(Layer.mergeAll(embeddingLayer, FileEmbeddingCacheLive)),
      Effect.map((outcome) => outcome.vectorsByNodeKey),
      Effect.catchCause((cause) =>
        isPureInterruptCause(cause)
          ? Effect.interrupt
          : Effect.succeed(
              new Map<
                EmbeddingNodeKey,
                { readonly components: ReadonlyArray<EmbeddingComponent> }
              >(),
            ),
      ),
    )
    if (vectors.size === 0) return []

    const activeDocIds = new Set(
      docs
        .filter((d) =>
          match(d.status)
            .with("accepted", "proposed", () => true)
            .with("deprecated", "superseded", () => false)
            .exhaustive(),
        )
        .map((d) => d.id),
    )
    const items: Array<RequirementEmbeddingItem> = []
    for (const [, node] of Graph.nodes(graph.graph)) {
      match(node)
        .with({ _tag: "EarsRequirement" }, (req) => {
          if (!activeDocIds.has(req.specId)) return
          const nodeKey = EmbeddingNodeKey.make(`EarsRequirement:${req.id}`)
          const vec = vectors.get(nodeKey)
          if (vec === undefined || vec.components.length === 0) return
          items.push({
            nodeKey,
            specId: GovernanceDocIdentifier.make(req.specId),
            requirementId: RequirementId.make(req.requirementId),
            clauseText: EarsClauseText.make(req.clauseText),
            effectSymbol: EarsEffectSymbol.make(req.effectSymbol),
            vector: { components: vec.components.map((c) => EmbeddingComponent.make(c)) },
          })
        })
        .with(
          { _tag: "EffectFn" },
          { _tag: "ServiceTag" },
          { _tag: "ServiceLayer" },
          { _tag: "TaggedError" },
          { _tag: "SchemaDef" },
          { _tag: "VitestCase" },
          { _tag: "PatternDoc" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          { _tag: "EffectSignature" },
          { _tag: "LayerFlow" },
          { _tag: "TraceabilityTuple" },
          { _tag: "HttpEndpointTuple" },
          { _tag: "MigrationTuple" },
          () => undefined,
        )
        .exhaustive()
    }
    if (items.length < 2) return []

    const pairResult = yield* decideSemanticConflictPairs({
      items,
      minSimilarity: SimilarityScore.make(0.84),
      maxPairs: ConflictPairLimit.make(4),
    })
    const seenKeys = new Set<string>()
    for (const p of existingPairs) {
      seenKeys.add(`${p.sourceId}<->${p.targetId}`)
      seenKeys.add(`${p.targetId}<->${p.sourceId}`)
    }
    const extraPairs: Array<OntologyConflictInput> = []
    for (const candidate of pairResult.candidates) {
      const sourceId = `${candidate.sourceId}#${candidate.sourceRequirementId}`
      const targetId = `${candidate.targetId}#${candidate.targetRequirementId}`
      if (seenKeys.has(`${sourceId}<->${targetId}`)) continue
      seenKeys.add(`${sourceId}<->${targetId}`)
      extraPairs.push({
        sourceId,
        sourceText: candidate.sourceText,
        targetId,
        targetText: candidate.targetText,
        sharedSymbol: `semantic-similarity:${candidate.similarity.toFixed(2)}`,
      })
    }
    return extraPairs
  })

export const buildOntologyAndGqToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_ontology_why"),
    description:
      "Trace upward from any symbol, service, layer, error, or span to Motivation (EARS & ADR)",
    inputSchema: OntologyWhyInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeOntologyWhyInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        return {
          ...queryOntologyWhy(graphStatus.graph, symbolOrSpan),
          ...graphStatusMeta(graphStatus),
        }
      }),
  },
  {
    name: McpToolName.make("harness_ontology_impact"),
    description:
      "Analyze cross-layer ArchiMate impact for a symbol, service, layer, error, or span",
    inputSchema: OntologyImpactInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeOntologyImpactInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        return {
          ...queryOntologyImpact(graphStatus.graph, symbolOrSpan),
          ...graphStatusMeta(graphStatus),
        }
      }),
  },
  {
    name: McpToolName.make("harness_ontology_check"),
    description:
      "Check deterministic cross-layer ArchiMate invariants and Clef semantic conflicts across governance docs and graph",
    inputSchema: OntologyCheckInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { scope } = yield* decodeOntologyCheckInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        const graph = graphStatus.graph
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        const checkedDocs =
          options?.governanceDocs !== undefined
            ? { docs: options.governanceDocs, findings: [] }
            : loadGovernanceDocsChecked(root, nodeSyncHostIo)
        if (checkedDocs.findings.length > 0) {
          const msg = checkedDocs.findings
            .map((f) => `[${f.kind}] ${f.location ?? f.nodeId}: ${f.message}`)
            .join("; ")
          return {
            clean: false,
            degraded: true,
            degradedReason: "unreadable-governance-docs",
            evaluationError: `Unreadable governance docs: ${msg}`,
            findings: checkedDocs.findings,
            semanticConflicts: [],
            evaluatedPairs: 0,
            layerCounts: {
              Motivation: 0,
              Business: 0,
              Application: 0,
              Technology: 0,
              Implementation: 0,
            },
          }
        }
        const docs = checkedDocs.docs
        const invariants = yield* decideOntologyInvariants({
          graph,
          governanceDocs: docs,
        })
        const deterministicPairs = yield* extractOntologyConflictPairs(docs, scope)
        const semanticCandidatePairs = yield* collectMcpSemanticConflictPairs(
          root,
          graph,
          docs,
          deterministicPairs,
          options,
        )
        const pairs = [...deterministicPairs, ...semanticCandidatePairs]
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const semanticReport = yield* evaluateOntologyConflictsWithStatus(pairs).pipe(
          Effect.provide(decisionLayer),
          Effect.catchCause((cause) => {
            if (isPureInterruptCause(cause)) {
              return Effect.interrupt
            }
            const pretty = Cause.pretty(cause)
            process.stderr.write(`[harness-mcp] ontology conflicts fallback: ${pretty}\n`)
            return Effect.succeed<OntologyConflictEvaluationReport>({
              conflicts: [],
              degraded: true,
              evaluationError: pretty,
            })
          }),
        )
        const degraded = graphStatus.degraded || semanticReport.degraded
        const evaluationError =
          [graphStatus.evaluationError, semanticReport.evaluationError]
            .filter((e): e is string => e !== undefined)
            .join("; ") || undefined
        const projection = projectOntologyLayers(graph)
        return {
          clean: invariants.clean && semanticReport.conflicts.length === 0 && !degraded,
          degraded,
          ...(graphStatus.degradedReason !== undefined
            ? { degradedReason: graphStatus.degradedReason }
            : {}),
          ...(evaluationError !== undefined ? { evaluationError } : {}),
          findings: invariants.findings,
          semanticConflicts: semanticReport.conflicts,
          evaluatedPairs: pairs.length,
          layerCounts: {
            Motivation: projection.layers.Motivation.length,
            Business: projection.layers.Business.length,
            Application: projection.layers.Application.length,
            Technology: projection.layers.Technology.length,
            Implementation: projection.layers.Implementation.length,
          },
        }
      }),
  },
  {
    name: McpToolName.make("harness_gq_query"),
    description:
      "Execute a canonical Omnigraph .gq query (against live Omnigraph v0.14.0 or deterministic in-memory fallback)",
    inputSchema: GqQueryInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { queryName, params, branch } = yield* decodeGqQueryInput(args)
        const graphStatus = yield* resolveGraphWithStatus(options, args)
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args, options)
        const skipSpawn =
          (options?.skipOmnigraphSpawn === true ||
            (options?.graph !== undefined && options?.skipOmnigraphSpawn !== false)) &&
          !process.env["OMNIGRAPH_URL"]
        const gqResult = yield* invokeOmnigraphNamedQuery({
          repoRoot: root,
          actor: "agent-mcp",
          name: queryName,
          params,
          branch,
          fallbackGraph: graphStatus.graph,
          ...(skipSpawn ? { baseUrl: "http://127.0.0.1:1" } : {}),
        }).pipe(Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)))

        const degraded = graphStatus.degraded || gqResult.degraded
        const degradedReasonParts: Array<string> = []
        if (graphStatus.degradedReason !== undefined) {
          degradedReasonParts.push(graphStatus.degradedReason)
        }
        if (gqResult.degraded) {
          degradedReasonParts.push(`omnigraph-fallback: ${gqResult.fallbackError}`)
        }
        const degradedReason =
          degradedReasonParts.length > 0 ? degradedReasonParts.join("; ") : undefined

        return {
          ...gqResult,
          degraded,
          ...(degradedReason !== undefined ? { degradedReason } : {}),
          ...(graphStatus.evaluationError !== undefined
            ? { evaluationError: graphStatus.evaluationError }
            : {}),
        }
      }),
  },
]
