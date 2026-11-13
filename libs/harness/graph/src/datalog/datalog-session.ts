import {
  D2,
  MessageType,
  MultiSet,
  consolidate,
  distinct,
  output,
  type KeyValue,
} from "@electric-sql/d2ts"
import { Context, Effect, Layer, Semaphore } from "effect"
import * as Graph from "effect/Graph"
import { match } from "ts-pattern"
import { runGraphInferencePipeline } from "./stratum-3-completion-and-holes.js"
import {
  type DatalogFileDeltaResult,
  type DatalogFilePath,
  GraphInferenceError,
  type GraphInferenceResult,
  type HarnessEdge,
  type HarnessGraph,
  HarnessGraphTypeId,
  type HarnessNode,
  NonNegativeCount,
  type SemanticEdgePriors,
  getEdgeKey,
  getNodeKey,
  isEntityNode,
  isRelationNode,
} from "../model.js"

export interface DatalogFileDeltaStepInput {
  readonly filePath: DatalogFilePath
  readonly nextGraph: HarnessGraph
  readonly priors?: SemanticEdgePriors | undefined
}

export interface DatalogSessionSnapshot {
  readonly epoch: NonNegativeCount
  readonly graph: HarnessGraph
  readonly inference: GraphInferenceResult
}

export interface DatalogSessionShape {
  readonly currentGraph: Effect.Effect<HarnessGraph>
  readonly latestInference: Effect.Effect<GraphInferenceResult, GraphInferenceError>
  readonly snapshot: Effect.Effect<DatalogSessionSnapshot>
  readonly stepFileDelta: (
    input: DatalogFileDeltaStepInput,
  ) => Effect.Effect<DatalogFileDeltaResult, GraphInferenceError>
}

const getEntityNodeFilePath = (node: HarnessNode): string | undefined =>
  match(node)
    .with(
      { _tag: "EffectFn" },
      { _tag: "ServiceTag" },
      { _tag: "ServiceLayer" },
      { _tag: "TaggedError" },
      { _tag: "SchemaDef" },
      (n) => n.file,
    )
    .with({ _tag: "VitestCase" }, (n) => n.testFile)
    .with({ _tag: "PatternDoc" }, { _tag: "AdrDoc" }, { _tag: "EarsSpec" }, (n) => n.path)
    .with({ _tag: "MigrationTuple" }, (n) => n.moduleFile)
    .with({ _tag: "EffectSignature" }, (n) => n.file)
    .with({ _tag: "LayerFlow" }, (n) => n.file)
    .with({ _tag: "HttpEndpointTuple" }, (n) => n.file)
    .with({ _tag: "TraceabilityTuple" }, (n) => {
      const hashIdx = n.targetSymbolQualname.indexOf("#")
      return hashIdx > 0 ? n.targetSymbolQualname.slice(0, hashIdx) : undefined
    })
    .exhaustive()

export const normalizeWorkspacePath = (p: string): string => {
  const forward = p.trim().replace(/\\/g, "/").replace(/\/+/g, "/")
  const withoutLeadingDot = forward.replace(/^\.\//, "")
  const workspaceAnchor = /(?:^|\/)((?:libs|apps|packages|tools|docs|samples)\/.+)$/.exec(
    withoutLeadingDot,
  )
  if (workspaceAnchor?.[1] !== undefined) {
    return workspaceAnchor[1]
  }
  return withoutLeadingDot.replace(/^\/+/, "")
}

const matchesFilePath = (candidateFile: string | undefined, targetFile: string): boolean => {
  if (candidateFile === undefined) {
    return false
  }
  const normCandidate = normalizeWorkspacePath(candidateFile)
  const normTarget = normalizeWorkspacePath(targetFile)
  return normCandidate.length > 0 && normCandidate === normTarget
}

const computeGraphStructureFingerprint = (graph: HarnessGraph): string => {
  const nodeEntries: Array<string> = []
  for (const [, node] of Graph.nodes(graph.graph)) {
    nodeEntries.push(`${getNodeKey(node)}:${JSON.stringify(node)}`)
  }
  nodeEntries.sort()

  const edgeEntries: Array<string> = []
  for (const [, edge] of Graph.edges(graph.graph)) {
    edgeEntries.push(`${getEdgeKey(edge.data)}:${JSON.stringify(edge.data)}`)
  }
  edgeEntries.sort()

  return JSON.stringify({
    nodes: nodeEntries,
    edges: edgeEntries,
    violations: graph.branchingViolations ?? [],
    unresolved: graph.unresolvedReferences ?? [],
  })
}

const extractFileEdbFacts = (
  graph: HarnessGraph,
  targetFile?: string,
): Map<string, ReadonlyArray<string>> => {
  const normalizedTarget = targetFile !== undefined ? normalizeWorkspacePath(targetFile) : undefined
  const nodeFileByKey = new Map<string, string>()
  const factsByFile = new Map<string, Set<string>>()

  const addFact = (rawFile: string, fact: string): void => {
    const normalizedFile = normalizeWorkspacePath(rawFile)
    if (normalizedFile.length === 0) {
      return
    }
    if (normalizedTarget !== undefined && normalizedFile !== normalizedTarget) {
      return
    }
    let set = factsByFile.get(normalizedFile)
    if (set === undefined) {
      set = new Set<string>()
      factsByFile.set(normalizedFile, set)
    }
    set.add(fact)
  }

  for (const [, node] of Graph.nodes(graph.graph)) {
    const key = getNodeKey(node)
    const rawFile = getEntityNodeFilePath(node) ?? normalizedTarget
    if (rawFile !== undefined) {
      const normalizedFile = normalizeWorkspacePath(rawFile)
      nodeFileByKey.set(key, normalizedFile)
      if (isRelationNode(node)) {
        nodeFileByKey.set(node.relationId, normalizedFile)
      }
      addFact(normalizedFile, `node:${key}:${JSON.stringify(node)}`)
    }
  }

  for (const [, edge] of Graph.edges(graph.graph)) {
    const data = edge.data
    const relFile = nodeFileByKey.get(data.relationId)
    const entFile = nodeFileByKey.get(data.entityKey)
    const edgeFact = `edge:${getEdgeKey(data)}`
    if (relFile !== undefined) {
      addFact(relFile, edgeFact)
    }
    if (entFile !== undefined && entFile !== relFile) {
      addFact(entFile, edgeFact)
    }
  }

  const out = new Map<string, ReadonlyArray<string>>()
  for (const [file, set] of factsByFile.entries()) {
    out.set(file, Array.from(set).sort())
  }
  return out
}

const mergeFileSubgraphIntoWorkspace = (
  baseGraph: HarnessGraph,
  filePath: string,
  nextGraph: HarnessGraph,
): HarnessGraph => {
  const normalizedTarget = normalizeWorkspacePath(filePath)
  const removedEntityKeys = new Set<string>()
  const removedRelationIds = new Set<string>()
  const keptNodes = new Map<string, HarnessNode>()

  for (const [, node] of Graph.nodes(baseGraph.graph)) {
    const key = getNodeKey(node)
    const file = getEntityNodeFilePath(node)
    if (matchesFilePath(file, normalizedTarget)) {
      if (isEntityNode(node)) {
        removedEntityKeys.add(key)
      } else if (isRelationNode(node)) {
        removedRelationIds.add(node.relationId)
        removedRelationIds.add(key)
      }
      continue
    }
    keptNodes.set(key, node)
  }

  const relationIncidentNonRemoved = new Set<string>()
  const relationIncidentRemoved = new Set<string>()
  for (const [, edge] of Graph.edges(baseGraph.graph)) {
    const { relationId, entityKey } = edge.data
    if (removedEntityKeys.has(entityKey)) {
      relationIncidentRemoved.add(relationId)
    } else {
      relationIncidentNonRemoved.add(relationId)
    }
  }

  for (const [key, node] of Array.from(keptNodes.entries())) {
    if (isRelationNode(node)) {
      if (
        relationIncidentRemoved.has(node.relationId) &&
        !relationIncidentNonRemoved.has(node.relationId)
      ) {
        keptNodes.delete(key)
        removedRelationIds.add(node.relationId)
        removedRelationIds.add(key)
      }
    }
  }

  for (const [, node] of Graph.nodes(nextGraph.graph)) {
    keptNodes.set(getNodeKey(node), node)
  }

  const keptEdges = new Map<string, HarnessEdge>()
  for (const [, edge] of Graph.edges(baseGraph.graph)) {
    const data = edge.data
    if (removedRelationIds.has(data.relationId)) {
      continue
    }
    const relNodeKeyExists =
      keptNodes.has(data.relationId) ||
      Array.from(keptNodes.values()).some(
        (n) => isRelationNode(n) && n.relationId === data.relationId,
      )
    if (relNodeKeyExists && keptNodes.has(data.entityKey)) {
      keptEdges.set(getEdgeKey(data), data)
    }
  }
  for (const [, edge] of Graph.edges(nextGraph.graph)) {
    keptEdges.set(getEdgeKey(edge.data), edge.data)
  }

  const nodeIndexByKey = new Map<string, Graph.NodeIndex>()
  const directed = Graph.directed<HarnessNode, HarnessEdge>((mutable) => {
    for (const [key, node] of keptNodes.entries()) {
      const idx = Graph.addNode(mutable, node)
      nodeIndexByKey.set(key, idx)
      if (isRelationNode(node)) {
        nodeIndexByKey.set(node.relationId, idx)
      }
    }
    for (const edge of keptEdges.values()) {
      const relIdx = nodeIndexByKey.get(edge.relationId)
      const entIdx = nodeIndexByKey.get(edge.entityKey)
      if (relIdx !== undefined && entIdx !== undefined) {
        Graph.addEdge(mutable, relIdx, entIdx, edge)
      }
    }
  })

  const preservedViolations = (baseGraph.branchingViolations ?? []).filter(
    (v) => !matchesFilePath(v.file, normalizedTarget),
  )
  const nextViolations = nextGraph.branchingViolations ?? []

  const preservedUnresolved = (baseGraph.unresolvedReferences ?? []).filter(
    (u) => !matchesFilePath(u.file, normalizedTarget),
  )
  const nextUnresolved = nextGraph.unresolvedReferences ?? []

  return {
    [HarnessGraphTypeId]: HarnessGraphTypeId,
    graph: directed,
    nodeIndexByKey,
    branchingViolations: [...preservedViolations, ...nextViolations],
    unresolvedReferences: [...preservedUnresolved, ...nextUnresolved],
  }
}

const MAX_D2_STEPS = 10_000

const stepD2Bounded = (d2: D2): boolean => {
  let steps = 0
  while (d2.pendingWork()) {
    if (steps >= MAX_D2_STEPS) {
      return false
    }
    d2.step()
    steps += 1
  }
  return true
}

export class DatalogSession extends Context.Service<DatalogSession, DatalogSessionShape>()(
  "@harness/graph/DatalogSession",
) {
  static readonly make = (
    initialGraph: HarnessGraph,
    initialPriors?: SemanticEdgePriors,
  ): Effect.Effect<DatalogSessionShape, GraphInferenceError> =>
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(1)
      let activeGraph = initialGraph
      let activePriors = initialPriors
      let activeFingerprint = computeGraphStructureFingerprint(initialGraph)
      let activeInference = yield* runGraphInferencePipeline(initialGraph, initialPriors).pipe(
        Effect.mapError((err) =>
          match(err)
            .with({ _tag: "GraphInferenceError" }, (e) => e)
            .with(
              { _tag: "ConceptLatticeCycleError" },
              (e) =>
                new GraphInferenceError({
                  reason: "concept-lattice-cycle",
                  message: e.message,
                }),
            )
            .exhaustive(),
        ),
      )
      let currentEpoch = 0

      const fileFactsByPath = new Map<string, ReadonlyArray<string>>()
      const initialFactsMap = extractFileEdbFacts(initialGraph)
      for (const [file, facts] of initialFactsMap.entries()) {
        fileFactsByPath.set(file, facts)
      }

      const materializedEdbZSet = new Map<string, number>()
      const d2 = new D2({ initialFrontier: 0 })
      const inFileEdb = d2.newInput<KeyValue<string, string>>()
      inFileEdb.pipe(
        distinct(),
        consolidate(),
        output((msg) => {
          match(msg)
            .with({ type: MessageType.DATA }, ({ data }) => {
              for (const [[fact, file], weight] of data.collection.getInner()) {
                const compositeKey = `${file}::${fact}`
                const nextWeight = (materializedEdbZSet.get(compositeKey) ?? 0) + weight
                if (nextWeight <= 0) {
                  materializedEdbZSet.delete(compositeKey)
                } else {
                  materializedEdbZSet.set(compositeKey, nextWeight)
                }
              }
            })
            .with({ type: MessageType.FRONTIER }, () => undefined)
            .exhaustive()
        }),
      )
      d2.finalize()
      let sessionPoisoned = false

      const initialEntries: Array<[KeyValue<string, string>, number]> = []
      for (const [file, facts] of fileFactsByPath.entries()) {
        for (const fact of facts) {
          initialEntries.push([[fact, file], 1])
        }
      }
      const initialConverged = yield* Effect.try({
        try: () => {
          const nextEpoch = currentEpoch + 1
          inFileEdb.sendData(currentEpoch, new MultiSet(initialEntries))
          inFileEdb.sendFrontier(nextEpoch)
          const converged = stepD2Bounded(d2)
          if (converged) {
            currentEpoch = nextEpoch
          }
          return converged
        },
        catch: (err) =>
          new GraphInferenceError({
            reason: "d2ts-session-step-failed",
            message: String(err),
          }),
      })
      if (!initialConverged) {
        return yield* new GraphInferenceError({
          reason: "d2ts-session-step-failed",
          message: `D2 session exceeded ${MAX_D2_STEPS} pending steps without converging.`,
        })
      }

      return DatalogSession.of({
        currentGraph: Effect.sync(() => activeGraph),
        latestInference: Effect.sync(() => activeInference),
        snapshot: semaphore.withPermits(1)(
          Effect.sync(() => ({
            epoch: NonNegativeCount.make(currentEpoch),
            graph: activeGraph,
            inference: activeInference,
          })),
        ),
        stepFileDelta: (input) =>
          semaphore.withPermits(1)(
            Effect.gen(function* () {
              if (sessionPoisoned) {
                return yield* new GraphInferenceError({
                  reason: "d2ts-session-step-failed",
                  message: "D2 session is poisoned after a previous failed or non-converged step.",
                })
              }
              const normalizedTarget = normalizeWorkspacePath(input.filePath)
              if (normalizedTarget.length === 0) {
                return yield* new GraphInferenceError({
                  reason: "invalid-graph",
                  message: `Invalid empty or whitespace filePath '${input.filePath}' passed to DatalogSession.stepFileDelta.`,
                })
              }

              const nextPriors = input.priors !== undefined ? input.priors : activePriors
              const mergedGraph = mergeFileSubgraphIntoWorkspace(
                activeGraph,
                normalizedTarget,
                input.nextGraph,
              )

              const oldFacts = new Set<string>(fileFactsByPath.get(normalizedTarget) ?? [])
              const nextFileMap = extractFileEdbFacts(mergedGraph, normalizedTarget)
              const newFactsArray = nextFileMap.get(normalizedTarget) ?? []
              const newFacts = new Set<string>(newFactsArray)

              const deltaEntries: Array<[KeyValue<string, string>, number]> = []
              let retractedFactCount = 0
              let insertedFactCount = 0

              for (const oldFact of oldFacts) {
                if (!newFacts.has(oldFact)) {
                  deltaEntries.push([[oldFact, normalizedTarget], -1])
                  retractedFactCount += 1
                }
              }
              for (const newFact of newFacts) {
                if (!oldFacts.has(newFact)) {
                  deltaEntries.push([[newFact, normalizedTarget], 1])
                  insertedFactCount += 1
                }
              }

              const nextFingerprint = computeGraphStructureFingerprint(mergedGraph)
              const isNoOpDelta =
                retractedFactCount === 0 &&
                insertedFactCount === 0 &&
                input.priors === undefined &&
                activeFingerprint === nextFingerprint

              const nextInference = isNoOpDelta
                ? activeInference
                : yield* runGraphInferencePipeline(mergedGraph, nextPriors).pipe(
                    Effect.mapError((err) =>
                      match(err)
                        .with({ _tag: "GraphInferenceError" }, (e) => e)
                        .with(
                          { _tag: "ConceptLatticeCycleError" },
                          (e) =>
                            new GraphInferenceError({
                              reason: "concept-lattice-cycle",
                              message: e.message,
                            }),
                        )
                        .exhaustive(),
                    ),
                  )

              const nextEpoch = currentEpoch + 1
              const stepConverged = yield* Effect.try({
                try: () => {
                  inFileEdb.sendData(currentEpoch, new MultiSet(deltaEntries))
                  inFileEdb.sendFrontier(nextEpoch)
                  return stepD2Bounded(d2)
                },
                catch: (err) => {
                  sessionPoisoned = true
                  return new GraphInferenceError({
                    reason: "d2ts-session-step-failed",
                    message: String(err),
                  })
                },
              })
              if (!stepConverged) {
                sessionPoisoned = true
                return yield* new GraphInferenceError({
                  reason: "d2ts-session-step-failed",
                  message: `D2 session exceeded ${MAX_D2_STEPS} pending steps without converging.`,
                })
              }

              currentEpoch = nextEpoch
              if (newFactsArray.length > 0) {
                fileFactsByPath.set(normalizedTarget, newFactsArray)
              } else {
                fileFactsByPath.delete(normalizedTarget)
              }
              activeGraph = mergedGraph
              activePriors = nextPriors
              activeFingerprint = nextFingerprint
              activeInference = nextInference

              return {
                filePath: input.filePath,
                epoch: NonNegativeCount.make(currentEpoch),
                retractedFactCount: NonNegativeCount.make(retractedFactCount),
                insertedFactCount: NonNegativeCount.make(insertedFactCount),
                inference: activeInference,
              } satisfies DatalogFileDeltaResult
            }),
          ),
      })
    })

  static readonly layer = (
    initialGraph: HarnessGraph,
    priors?: SemanticEdgePriors,
  ): Layer.Layer<DatalogSession, GraphInferenceError> =>
    Layer.effect(DatalogSession, DatalogSession.make(initialGraph, priors))
}

export const datalogSessionLive: Layer.Layer<DatalogSession, GraphInferenceError> = Layer.effect(
  DatalogSession,
  Effect.suspend(() =>
    DatalogSession.make({
      [HarnessGraphTypeId]: HarnessGraphTypeId,
      graph: Graph.directed<HarnessNode, HarnessEdge>(() => {}),
      nodeIndexByKey: new Map(),
      branchingViolations: [],
      unresolvedReferences: [],
    }),
  ),
)

export const stepDatalogFileDelta = Effect.fn("DatalogSession.stepFileDelta")(function* (
  input: DatalogFileDeltaStepInput,
): Effect.fn.Return<DatalogFileDeltaResult, GraphInferenceError, DatalogSession> {
  const session = yield* DatalogSession
  return yield* session.stepFileDelta(input)
})
