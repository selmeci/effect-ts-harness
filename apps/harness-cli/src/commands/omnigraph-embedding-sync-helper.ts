import { Effect, Graph, Layer } from "effect"
import { match } from "ts-pattern"
import {
  ConflictPairLimit,
  EarsClauseText,
  EarsEffectSymbol,
  EmbeddingComponent,
  EmbeddingNodeKey,
  GovernanceDocIdentifier,
  type RequirementEmbeddingItem,
  RequirementId,
  SimilarityScore,
  WorkspaceFilePath,
} from "@harness/contract"
import { decideSemanticConflictPairs, type OntologyConflictInput } from "@harness/decision"
import { decideEmbeddingSyncPlan, type GovernanceDocReference } from "@harness/gates"
import { type HarnessGraph, syncGraphEmbeddings } from "@harness/graph"
import { FileEmbeddingCacheLive, OllamaEmbeddingClientLive } from "@harness/infra"
import { isIsolatedExternalWorkspace } from "./daemon-and-omnigraph.service.js"

const DEFAULT_SEMANTIC_MIN_SIMILARITY = 0.84
const DEFAULT_SEMANTIC_MAX_PAIRS = 4

export const computeSyncEmbeddingsForGraph = (
  repoRoot: string,
  graph: HarnessGraph,
  options?: { readonly skipBackgroundDaemons?: boolean | undefined },
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<number>>> => {
  if (options?.skipBackgroundDaemons === true || isIsolatedExternalWorkspace(repoRoot)) {
    return Effect.succeed(new Map())
  }
  return syncGraphEmbeddings({
    graph,
    repoRoot: WorkspaceFilePath.make(repoRoot),
    decidePlan: decideEmbeddingSyncPlan,
  }).pipe(
    Effect.provide(Layer.mergeAll(OllamaEmbeddingClientLive, FileEmbeddingCacheLive)),
    Effect.map((outcome) => {
      const result = new Map<string, ReadonlyArray<number>>()
      for (const [nodeKey, vec] of outcome.vectorsByNodeKey) {
        result.set(nodeKey, vec.components)
      }
      return result as ReadonlyMap<string, ReadonlyArray<number>>
    }),
    Effect.orElseSucceed(() => new Map<string, ReadonlyArray<number>>()),
  )
}

export const extractSemanticCandidateConflictPairs = (
  repoRoot: string,
  graph: HarnessGraph,
  docs: ReadonlyArray<GovernanceDocReference>,
  existingPairs: ReadonlyArray<OntologyConflictInput>,
  options?: { readonly skipBackgroundDaemons?: boolean | undefined },
): Effect.Effect<ReadonlyArray<OntologyConflictInput>> =>
  Effect.gen(function* () {
    if (options?.skipBackgroundDaemons === true || docs.length === 0) {
      return []
    }
    const vectors = yield* computeSyncEmbeddingsForGraph(repoRoot, graph, options)
    if (vectors.size === 0) {
      return []
    }
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
          const key = `EarsRequirement:${req.id}`
          const components = vectors.get(key)
          if (components === undefined || components.length === 0) return
          items.push({
            nodeKey: EmbeddingNodeKey.make(key),
            specId: GovernanceDocIdentifier.make(req.specId),
            requirementId: RequirementId.make(req.requirementId),
            clauseText: EarsClauseText.make(req.clauseText),
            effectSymbol: EarsEffectSymbol.make(req.effectSymbol),
            vector: { components: components.map((c) => EmbeddingComponent.make(c)) },
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

    if (items.length < 2) {
      return []
    }

    const pairResult = yield* decideSemanticConflictPairs({
      items,
      minSimilarity: SimilarityScore.make(DEFAULT_SEMANTIC_MIN_SIMILARITY),
      maxPairs: ConflictPairLimit.make(DEFAULT_SEMANTIC_MAX_PAIRS),
    })

    const existingKeys = new Set<string>()
    for (const p of existingPairs) {
      existingKeys.add(`${p.sourceId}<->${p.targetId}`)
      existingKeys.add(`${p.targetId}<->${p.sourceId}`)
    }

    const extraPairs: Array<OntologyConflictInput> = []
    for (const candidate of pairResult.candidates) {
      const sourceId = `${candidate.sourceId}#${candidate.sourceRequirementId}`
      const targetId = `${candidate.targetId}#${candidate.targetRequirementId}`
      if (existingKeys.has(`${sourceId}<->${targetId}`)) continue
      existingKeys.add(`${sourceId}<->${targetId}`)
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
