import { Cause, Effect, Layer, Schema } from "effect"
import { isPureInterruptCause, WorkspaceFilePath } from "@harness/contract"
import {
  HARNESS_GQ_QUERY_NAMES,
  invokeOmnigraphNamedQuery,
  makeOmnigraphSyncLayer,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
} from "@harness/graph"
import {
  collectSemanticConflictCandidates,
  decideOntologyInvariants,
  evaluateOntologyConflictsWithStatus,
  extractOntologyConflictPairs,
  type OntologyConflictEvaluationReport,
} from "@harness/decision"
import { loadGovernanceDocsChecked } from "@harness/gates"
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
  resolveContainedRepoRoot,
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
        const { symbolOrSpan, repoRoot } = yield* decodeOntologyWhyInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
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
        const { symbolOrSpan, repoRoot } = yield* decodeOntologyImpactInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
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
        const { scope, repoRoot } = yield* decodeOntologyCheckInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
        const graph = graphStatus.graph
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
        const embeddingLayer = options?.embeddingClientLayer ?? OllamaEmbeddingClientLive
        const embeddingCacheLayer = options?.embeddingCacheLayer ?? FileEmbeddingCacheLive
        const semanticCandidateRes = yield* collectSemanticConflictCandidates({
          repoRoot: WorkspaceFilePath.make(root),
          graph,
          docs,
          existingPairs: deterministicPairs,
        }).pipe(Effect.provide(Layer.mergeAll(embeddingLayer, embeddingCacheLayer)))
        const pairs = [...deterministicPairs, ...semanticCandidateRes.pairs]
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
        const degraded =
          graphStatus.degraded || semanticCandidateRes.degraded || semanticReport.degraded
        const degradedReason =
          [graphStatus.degradedReason, semanticCandidateRes.degradedReason ?? undefined]
            .filter((v): v is string => v !== undefined && v.length > 0)
            .join("; ") || undefined
        const evaluationError =
          [
            graphStatus.evaluationError,
            semanticCandidateRes.degradedReason !== null
              ? `Semantic conflict embedding check degraded: ${semanticCandidateRes.degradedReason}`
              : undefined,
            semanticReport.evaluationError,
          ]
            .filter((e): e is string => e !== undefined && e.length > 0)
            .join("; ") || undefined
        const projection = projectOntologyLayers(graph)
        return {
          clean: invariants.clean && semanticReport.conflicts.length === 0 && !degraded,
          degraded,
          ...(degradedReason !== undefined ? { degradedReason } : {}),
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
        const { queryName, params, branch, repoRoot } = yield* decodeGqQueryInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const graphStatus = yield* resolveGraphWithStatus({ ...options, repoRoot: root }, args)
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
