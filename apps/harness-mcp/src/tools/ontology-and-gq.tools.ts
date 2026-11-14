import { Cause, Effect, Schema } from "effect"
import {
  HARNESS_GQ_QUERY_NAMES,
  invokeOmnigraphNamedQuery,
  makeOmnigraphSyncLayer,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
} from "@harness/graph"
import {
  decideOntologyInvariants,
  evaluateOntologyConflicts,
  extractOntologyConflictPairs,
  loadGovernanceDocsFromDisk,
  LocalDecisionModel,
} from "@harness/decision"
import { nodeSyncHostIo } from "@harness/infra"
import {
  McpToolName,
  type McpToolPluginDescriptor,
  resolveDefaultRepoRoot,
  resolveGraph,
  type ServerOptions,
} from "./mcp-helpers.js"

const OntologyWhyInputSchema = Schema.Struct({
  symbolOrSpan: Schema.String.annotate({
    description: "Symbol, service, layer, error, or span name to trace upward to Motivation (EARS & ADR)",
  }),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const OntologyImpactInputSchema = Schema.Struct({
  symbolOrSpan: Schema.String.annotate({
    description:
      "Symbol, service, layer, error, or span name to analyze cross-layer ArchiMate impact for",
  }),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const OntologyCheckInputSchema = Schema.Struct({
  scope: Schema.optional(
    Schema.String.annotate({
      description:
        "Optional scope name (e.g. 'sample') to check deterministic cross-layer invariants and Clef semantic conflicts",
    }),
  ),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const GqQueryInputSchema = Schema.Struct({
  queryName: Schema.Literals(HARNESS_GQ_QUERY_NAMES).annotate({
    description: "Name of the canonical .gq query in libs/harness/graph/queries/harness.gq",
  }),
  params: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Query parameters matching $var placeholders",
    }),
  ),
  branch: Schema.optional(
    Schema.String.annotate({
      description: "Target graph branch (defaults to 'main')",
    }),
  ),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Target repository root for cluster resolution",
    }),
  ),
})

const decodeOntologyTargetInput = Schema.decodeUnknownEffect(OntologyWhyInputSchema)
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
        const { symbolOrSpan } = yield* decodeOntologyTargetInput(args)
        const graph = yield* resolveGraph(options, args)
        return queryOntologyWhy(graph, symbolOrSpan)
      }),
  },
  {
    name: McpToolName.make("harness_ontology_impact"),
    description: "Analyze cross-layer ArchiMate impact for a symbol, service, layer, error, or span",
    inputSchema: OntologyImpactInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan } = yield* decodeOntologyTargetInput(args)
        const graph = yield* resolveGraph(options, args)
        return queryOntologyImpact(graph, symbolOrSpan)
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
        const graph = yield* resolveGraph(options, args)
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        const docs = options?.governanceDocs ?? loadGovernanceDocsFromDisk(root, nodeSyncHostIo)
        const invariants = yield* decideOntologyInvariants({
          graph,
          governanceDocs: docs,
        })
        const pairs = yield* extractOntologyConflictPairs(docs, scope)
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const semanticConflicts = yield* evaluateOntologyConflicts(pairs).pipe(
          Effect.provide(decisionLayer),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) {
              return Effect.interrupt
            }
            process.stderr.write(`[harness-mcp] ontology conflicts fallback: ${Cause.pretty(cause)}\n`)
            return Effect.succeed([])
          }),
        )
        const projection = projectOntologyLayers(graph)
        return {
          clean: invariants.clean && semanticConflicts.length === 0,
          findings: invariants.findings,
          semanticConflicts,
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
        const graph = yield* resolveGraph(options, args)
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args, options)
        const skipSpawn = options?.skipOmnigraphSpawn === true && !process.env["OMNIGRAPH_URL"]
        return yield* invokeOmnigraphNamedQuery({
          repoRoot: root,
          name: queryName,
          params,
          branch,
          fallbackGraph: graph,
          ...(skipSpawn ? { baseUrl: "http://127.0.0.1:1" } : {}),
        }).pipe(Effect.provide(makeOmnigraphSyncLayer(nodeSyncHostIo)))
      }),
  },
]
