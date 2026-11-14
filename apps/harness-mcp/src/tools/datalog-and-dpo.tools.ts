import { Cause, Effect, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import {
  BisectionProbeCount,
  ConfidenceMillis,
  decideGraphInference,
  decideGraphProjection,
  decideGraphRewrite,
  type DpoCandidatePriors,
  type EffectFnNode,
  type EntityNode,
  getNodeKey,
  GraphInferenceError,
  type HarnessGraph,
  isEntityNode,
  NodeKey,
  PageRankScoreMillis,
  resolveNode,
  type RewriteMode,
  type SemanticEdgePriors,
  VerificationStatus,
} from "@harness/graph"
import {
  CandidateSymbolKey,
  evaluateDpoCandidatePriorsBatch,
  evaluateHoleCandidatePrior,
  LocalDecisionModel,
  ProposedRoleName,
} from "@harness/decision"
import {
  McpToolName,
  type McpToolPluginDescriptor,
  resolveDefaultRepoRoot,
  resolveGraph,
  type ServerOptions,
} from "./mcp-helpers.js"

if (!("iterations" in globalThis)) {
  Object.assign(globalThis, { iterations: 0 })
}

const GraphInferInputSchema = Schema.Struct({
  symbolOrSpan: Schema.optional(
    Schema.String.annotate({
      description: "Optional symbol or span filter for derived facts and antipatterns",
    }),
  ),
  ruleId: Schema.optional(
    Schema.String.annotate({
      description: "Optional Datalog rule ID filter (e.g. 'INF-04', 'INF-05')",
    }),
  ),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const GraphCompleteInputSchema = Schema.Struct({
  symbolOrSpan: Schema.optional(
    Schema.String.annotate({
      description: "Optional symbol or span filter for suggested hyperedges",
    }),
  ),
  minConfidenceMillis: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))).annotate({
      description: "Minimum confidence in millis (0..1000, default 0)",
    }),
  ),
  ruleId: Schema.optional(
    Schema.String.annotate({
      description: "Optional completion rule ID filter (e.g. 'COMP-01'..'COMP-05')",
    }),
  ),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
  useDecisionPriors: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Optional flag to evaluate System One edge and teleportation priors for typed holes",
    }),
  ),
  priors: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Optional explicit SemanticEdgePriors object for graph completion scoring",
    }),
  ),
})

const GraphRewriteInputSchema = Schema.Struct({
  mode: Schema.optional(
    Schema.Literals(["auto-plan", "auto-repair", "cleanup", "full"]).annotate({
      description: "Rewrite phase mode (defaults to 'auto-repair')",
    }),
  ),
  ruleId: Schema.optional(
    Schema.String.annotate({
      description: "Optional DPO rule ID filter (e.g. 'PLAN-01'..'PLAN-04', 'REP-01'..'REP-11')",
    }),
  ),
  candidateRank: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))).annotate({
      description: "Candidate rank to project (1..5, default 1)",
    }),
  ),
  useDecisionPriors: Schema.optional(
    Schema.Boolean.annotate({
      description: "Optional flag to evaluate DpoCandidateRankerV1 System One tie-breaking priors",
    }),
  ),
  verifyRoundTrip: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Optional flag to verify Stratum-Boundary Batch Shadow LSP & Round-Trip isomorphism with O(log k) bisection",
    }),
  ),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
})

const decodeGraphInferInput = Schema.decodeUnknownEffect(GraphInferInputSchema)
const decodeGraphCompleteInput = Schema.decodeUnknownEffect(GraphCompleteInputSchema)
const decodeGraphRewriteInput = Schema.decodeUnknownEffect(GraphRewriteInputSchema)
const decodeConfidence = Schema.decodeUnknownEffect(ConfidenceMillis)
const decodeTeleportWeight = Schema.decodeUnknownEffect(PageRankScoreMillis)

const resolveDecisionPriors = Effect.fn("HarnessMcp.resolveDecisionPriors")(function* (
  graph: HarnessGraph,
  symbolOrSpan: string | undefined,
  options?: ServerOptions,
) {
  const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
  const edgeConfidenceOverrides: Record<string, ConfidenceMillis> = {}
  const holeTeleportationWeights: Record<NodeKey, PageRankScoreMillis> = {}
  const stubFns: Array<EffectFnNode> = []
  const candidateEntities: Array<EntityNode> = []

  for (const [, node] of Graph.nodes(graph.graph)) {
    if (isEntityNode(node)) {
      if (node._tag === "EffectFn" && node.isStub === true) {
        stubFns.push(node)
      }
      if (
        (node._tag === "EffectFn" && node.isStub !== true) ||
        node._tag === "ServiceTag" ||
        node._tag === "TaggedError" ||
        node._tag === "SchemaDef"
      ) {
        candidateEntities.push(node)
      }
    }
  }

  if (stubFns.length === 0) {
    const candidateNode = symbolOrSpan ? resolveNode(graph, symbolOrSpan) : undefined
    if (candidateNode && candidateNode._tag === "EffectFn") {
      stubFns.push(candidateNode)
    } else {
      for (const [, node] of Graph.nodes(graph.graph)) {
        if (node._tag === "EffectFn") {
          stubFns.push(node)
          break
        }
      }
    }
  }

  for (const stub of stubFns) {
    const holeSpanName = stub.spanName.length > 0 ? stub.spanName : stub.qualname
    for (const cand of candidateEntities) {
      const candKey = getNodeKey(cand)
      const proposedRole = match(cand._tag)
        .with("ServiceTag", () => "requires-service")
        .with("TaggedError", () => "fails-with")
        .with("EffectFn", () => "callee")
        .with("SchemaDef", () => "uses-schema")
        .otherwise(() => "collaborator")

      const candidateSummary = match(cand)
        .with({ _tag: "EffectFn" }, (n) => `Effect.fn('${n.spanName}')`)
        .with({ _tag: "ServiceTag" }, (n) => `Context.Service<${n.name}>`)
        .with({ _tag: "TaggedError" }, (n) => `TaggedError('${n.errorTag}')`)
        .with({ _tag: "SchemaDef" }, (n) => `Schema '${n.schemaName}'`)
        .with(
          { _tag: "ServiceLayer" },
          { _tag: "VitestCase" },
          { _tag: "PatternDoc" },
          { _tag: "AdrDoc" },
          { _tag: "EarsSpec" },
          () => candKey,
        )
        .exhaustive()

      const priorResult = yield* evaluateHoleCandidatePrior({
        holeSpanName,
        holeSignatureSummary: stub.successType ?? "Effect<unknown, unknown, unknown>",
        candidateSymbolKey: CandidateSymbolKey.make(candKey),
        candidateSignatureSummary: candidateSummary,
        proposedRole: ProposedRoleName.make(proposedRole),
        earsClauseContext: `While executing ${stub.spanName}, hole delegates to ${candKey}`,
      }).pipe(
        Effect.provide(decisionLayer),
        Effect.timeoutOption("1500 millis"),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeedNone,
        ),
      )

      if (Option.isSome(priorResult)) {
        edgeConfidenceOverrides[candKey] = priorResult.value.edgeConfidenceMillis
        holeTeleportationWeights[NodeKey.make(candKey)] = PageRankScoreMillis.make(
          priorResult.value.teleportationWeightMillis,
        )
      }
    }
  }

  return {
    edgeConfidenceOverrides,
    holeTeleportationWeights,
  } satisfies SemanticEdgePriors
})

const extractPriorSourceEntries = (
  rawPriors: object,
  primaryKey: string,
  legacyKey: string,
): ReadonlyArray<readonly [string, unknown]> => {
  const primary = Reflect.get(rawPriors, primaryKey)
  if (typeof primary === "object" && primary !== null) {
    return Object.entries(primary)
  }
  const legacy = Reflect.get(rawPriors, legacyKey)
  if (typeof legacy === "object" && legacy !== null) {
    return Object.entries(legacy)
  }
  return []
}

const decodeRawPriors = Effect.fn("HarnessMcp.decodeRawPriors")(function* (
  rawPriors: unknown,
): Effect.fn.Return<SemanticEdgePriors, GraphInferenceError> {
  if (typeof rawPriors !== "object" || rawPriors === null) {
    return yield* new GraphInferenceError({
      reason: "invalid-graph",
      message: "Expected priors to be a non-null object.",
    })
  }
  const edgeOverrides: Record<string, ConfidenceMillis> = {}
  const teleportWeights: Record<NodeKey, PageRankScoreMillis> = {}
  const edgeEntries = extractPriorSourceEntries(
    rawPriors,
    "edgeConfidenceOverrides",
    "edgeConfidenceByRelationTargetRole",
  )
  for (const [k, v] of edgeEntries) {
    edgeOverrides[k] = yield* decodeConfidence(v).pipe(
      Effect.mapError(
        (err) =>
          new GraphInferenceError({
            reason: "invalid-graph",
            message: `Invalid edge confidence prior for '${k}': ${String(err)}`,
          }),
      ),
    )
  }
  const teleportEntries = extractPriorSourceEntries(
    rawPriors,
    "holeTeleportationWeights",
    "teleportationWeightByNodeKey",
  )
  for (const [k, v] of teleportEntries) {
    teleportWeights[NodeKey.make(k)] = yield* decodeTeleportWeight(v).pipe(
      Effect.mapError(
        (err) =>
          new GraphInferenceError({
            reason: "invalid-graph",
            message: `Invalid teleportation weight prior for '${k}': ${String(err)}`,
          }),
      ),
    )
  }
  return {
    edgeConfidenceOverrides: edgeOverrides,
    holeTeleportationWeights: teleportWeights,
  }
})

export const buildDatalogAndDpoToolDescriptors = (
  options?: ServerOptions,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_graph_infer"),
    description:
      "Run the Stratified Datalog inference engine (GraphInfer.decide over @electric-sql/d2ts) on the PERA hypergraph to compute transitive closures, antipatterns (INF-04..09), and derivation proofs",
    inputSchema: GraphInferInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { symbolOrSpan, ruleId } = yield* decodeGraphInferInput(args)
        const graph = yield* resolveGraph(options, args)
        const resolvedNode =
          symbolOrSpan !== undefined && symbolOrSpan.length > 0
            ? resolveNode(graph, symbolOrSpan)
            : undefined
        const resolvedKey = resolvedNode !== undefined ? getNodeKey(resolvedNode) : undefined
        const inference = yield* decideGraphInference(graph)
        const filterBySymbol = (text: string): boolean =>
          symbolOrSpan === undefined ||
          symbolOrSpan.length === 0 ||
          text.includes(symbolOrSpan) ||
          (resolvedKey !== undefined && text.includes(resolvedKey))
        return {
          effectiveRequires: inference.effectiveRequires.filter(
            (f) => filterBySymbol(f.callerKey) || filterBySymbol(f.serviceKey),
          ),
          effectiveFailsWith: inference.effectiveFailsWith.filter(
            (f) => filterBySymbol(f.callerKey) || filterBySymbol(f.errorKey),
          ),
          effectiveLayerDeps: inference.effectiveLayerDeps.filter(
            (f) => filterBySymbol(f.layerKey) || filterBySymbol(f.requiredServiceKey),
          ),
          effectiveTestReach: inference.effectiveTestReach.filter(
            (f) => filterBySymbol(f.testKey) || filterBySymbol(f.targetSpanKey),
          ),
          antiPatterns: inference.antiPatterns.filter(
            (ap) =>
              (ruleId === undefined || ap.ruleId === ruleId || ap.datalogRuleId === ruleId) &&
              (filterBySymbol(ap.nodeKey) || ap.path.some((p) => filterBySymbol(p))),
          ),
          typedHoleBundles: (inference.typedHoleBundles ?? []).filter(
            (b) => filterBySymbol(b.holeQualname) || filterBySymbol(b.spanName),
          ),
          proofs: inference.proofs.filter(
            (p) => (ruleId === undefined || p.ruleId === ruleId) && filterBySymbol(p.conclusion),
          ),
          iterations: inference.iterations ?? 0,
        }
      }),
  },
  {
    name: McpToolName.make("harness_graph_complete"),
    description:
      "Run normative missing-edge completion (COMP-01..05 in Stratum S3 of GraphInfer.decide) to propose SuggestedEdges with ConfidenceMillis and DerivationProof DAGs",
    inputSchema: GraphCompleteInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const input = yield* decodeGraphCompleteInput(args)
        const symbolOrSpan = input.symbolOrSpan
        const minConfidenceMillis = input.minConfidenceMillis ?? 0
        const ruleId = input.ruleId
        const useDecisionPriors = input.useDecisionPriors === true
        const rawPriors = input.priors
        const graph = yield* resolveGraph(options, args)
        const resolvedNode =
          symbolOrSpan !== undefined && symbolOrSpan.length > 0
            ? resolveNode(graph, symbolOrSpan)
            : undefined
        const resolvedKey = resolvedNode !== undefined ? getNodeKey(resolvedNode) : undefined
        const filterBySymbol = (text: string): boolean =>
          symbolOrSpan === undefined ||
          symbolOrSpan.length === 0 ||
          text.includes(symbolOrSpan) ||
          (resolvedKey !== undefined && text.includes(resolvedKey))

        const priors: SemanticEdgePriors | undefined = useDecisionPriors
          ? yield* resolveDecisionPriors(graph, symbolOrSpan, options)
          : rawPriors !== undefined
            ? yield* decodeRawPriors(rawPriors)
            : undefined

        const inference = yield* decideGraphInference(graph, priors)
        const suggestedEdges = inference.suggestedEdges.filter(
          (se) =>
            se.confidenceMillis >= minConfidenceMillis &&
            (ruleId === undefined || se.ruleId === ruleId || se.relationTag === ruleId) &&
            (symbolOrSpan === undefined ||
              symbolOrSpan.length === 0 ||
              (se.sourceEntityKey !== undefined && filterBySymbol(se.sourceEntityKey)) ||
              filterBySymbol(se.targetEntityKey) ||
              filterBySymbol(se.rationale)),
        )
        const typedHoleBundles = (inference.typedHoleBundles ?? []).filter(
          (b) => filterBySymbol(b.holeQualname) || filterBySymbol(b.spanName),
        )
        const proofIds = new Set<string>(suggestedEdges.map((se) => se.proof.proofId))
        for (const b of typedHoleBundles) {
          proofIds.add(`proof:COMP-06:EffectFn:${b.holeQualname}`)
        }
        return {
          suggestedEdges,
          typedHoleBundles,
          proofs: inference.proofs.filter((p) => proofIds.has(p.proofId)),
          iterations: inference.iterations ?? 0,
        }
      }),
  },
  {
    name: McpToolName.make("harness_graph_rewrite"),
    description:
      "Run Double-Pushout (DPO) algebraic hypergraph rewriting (GraphRewrite.decide) and bidirectional AST code projection (GraphProjector.decide) with in-memory ShadowFileOverlay generation",
    inputSchema: GraphRewriteInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const typedArgs = yield* decodeGraphRewriteInput(args)
        const mode: RewriteMode = typedArgs.mode ?? "auto-repair"
        const ruleId = typedArgs.ruleId
        const candidateRank = typedArgs.candidateRank ?? 1
        const useDecisionPriors = typedArgs.useDecisionPriors === true
        const verifyRoundTrip = typedArgs.verifyRoundTrip === true
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        const graph = yield* resolveGraph(options, args)

        let candidatePriors: DpoCandidatePriors | undefined = undefined
        if (useDecisionPriors) {
          const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
          const initialRewrite = yield* decideGraphRewrite(graph, mode)
          const initialCandidates = [
            ...Option.toArray(initialRewrite.result.recommendedCandidate),
            ...initialRewrite.result.alternativeCandidates,
          ]
          const allPatches = initialCandidates.flatMap((c) => c.patches)
          if (allPatches.length > 0) {
            const rankerBatch = yield* evaluateDpoCandidatePriorsBatch(
              allPatches.map((p) => ({
                primaryNodeKey: p.primaryNodeKey,
                ruleId: p.ruleId,
                violationKind: p.ruleId,
                callerSummary: p.description,
                candidatePatchSummary: `${p.ruleId} (+${p.insertedEntityNodes.length} entities, +${p.insertedRoleEdges.length} edges)`,
                earsClauseContext: p.description,
              })),
            ).pipe(Effect.provide(decisionLayer))
            candidatePriors = rankerBatch.candidatePriors
          }
        }

        const rewriteOutcome = yield* decideGraphRewrite(graph, mode, candidatePriors)
        const candidates = [
          ...Option.toArray(rewriteOutcome.result.recommendedCandidate),
          ...rewriteOutcome.result.alternativeCandidates,
        ]
        const selectedCandidate =
          candidates.find((c) => c.rank === candidateRank) ??
          Option.getOrUndefined(rewriteOutcome.result.recommendedCandidate) ??
          candidates[0]
        const filteredPatches =
          selectedCandidate !== undefined
            ? ruleId !== undefined && ruleId.length > 0
              ? selectedCandidate.patches.filter((p) => p.ruleId === ruleId)
              : selectedCandidate.patches
            : []

        const projection =
          selectedCandidate !== undefined
            ? yield* decideGraphProjection({
                patches: filteredPatches,
                targetGraph: rewriteOutcome.targetGraph,
                workspaceRoot: root,
                initialGraph: graph,
                verifyRoundTrip,
              })
            : {
                operations: [],
                overlays: [],
                verificationStatus: VerificationStatus.make("Unverified"),
                roundTripVerified: false,
                compilerDiagnostics: [],
                bisectionProbes: BisectionProbeCount.make(0),
                skippedRuleIds: [],
              }

        return {
          mode: rewriteOutcome.result.mode,
          initialMeasure: rewriteOutcome.result.initialMeasure,
          finalMeasure: selectedCandidate?.finalMeasure ?? rewriteOutcome.result.initialMeasure,
          totalStepsApplied: selectedCandidate?.patches.length ?? 0,
          selectedRank: selectedCandidate?.rank ?? null,
          priorsApplied: candidatePriors !== undefined,
          candidates: candidates.map((c) => ({
            rank: c.rank,
            patches: c.patches,
            finalMeasure: c.finalMeasure,
            systemOneTieBreaker: c.systemOneTieBreaker,
            isPolicyClean: c.isPolicyClean,
          })),
          projection,
        }
      }),
  },
]
