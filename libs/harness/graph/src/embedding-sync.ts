import { createHash } from "node:crypto"
import * as Graph from "effect/Graph"
import { Cause, Clock, Effect, Option } from "effect"
import { match } from "ts-pattern"
import {
  compareCodeUnits,
  EMBEDDING_CACHE_SCHEMA_VERSION,
  EmbeddingBatchTimestamp,
  type EmbeddingCacheSnapshot,
  EmbeddingComponent,
  EmbeddingContentHash,
  type EmbeddingModelId,
  EmbeddingNodeKey,
  type EmbeddingNodeKind,
  EmbeddingProviderError,
  EmbeddingSourceText,
  type EmbeddingSyncCandidateItem,
  type EmbeddingSyncPlanDecision,
  type EmbeddingSyncPlanInput,
  type EmbeddingVector,
  type EmbeddingVectorRecord,
  ErrorReasonMessage,
  isPureInterruptCause,
  NonNegativeCount,
  type RetrievalMode,
  toErrorReasonMessage,
  type WorkspaceFilePath,
} from "@harness/contract"
import { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import { type HarnessGraph, getNodeKey } from "./model.js"

const EMBED_BATCH_SIZE = 16

export interface GraphEmbeddingSyncInput {
  readonly graph: HarnessGraph
  readonly repoRoot: WorkspaceFilePath
  readonly decidePlan: (input: EmbeddingSyncPlanInput) => Effect.Effect<EmbeddingSyncPlanDecision>
}

export interface GraphEmbeddingSyncOutcome {
  readonly mode: RetrievalMode
  readonly model: EmbeddingModelId
  readonly totalItems: NonNegativeCount
  readonly embeddedDeltaCount: NonNegativeCount
  readonly reusedCacheCount: NonNegativeCount
  readonly degradedReason: ErrorReasonMessage | null
  readonly vectorsByNodeKey: ReadonlyMap<EmbeddingNodeKey, EmbeddingVector>
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex")

const normalizeAndValidateVector = (
  raw: EmbeddingVector,
  expectedDimensions: number,
  model: EmbeddingModelId,
): Effect.Effect<EmbeddingVector, EmbeddingProviderError> => {
  if (raw.components.length !== expectedDimensions) {
    return Effect.fail(
      new EmbeddingProviderError({
        model,
        reason: ErrorReasonMessage.make(
          `Expected ${expectedDimensions} vector dimensions, received ${raw.components.length}`,
        ),
      }),
    )
  }
  let sqSum = 0
  for (const c of raw.components) {
    if (!Number.isFinite(c)) {
      return Effect.fail(
        new EmbeddingProviderError({
          model,
          reason: ErrorReasonMessage.make("Embedding vector contains non-finite component"),
        }),
      )
    }
    sqSum += c * c
  }
  const norm = Math.sqrt(sqSum)
  if (!Number.isFinite(norm) || norm <= 0) {
    return Effect.fail(
      new EmbeddingProviderError({
        model,
        reason: ErrorReasonMessage.make("Embedding vector has zero or non-finite L2 norm"),
      }),
    )
  }
  return Effect.succeed({
    components: raw.components.map((c) => EmbeddingComponent.make(c / norm)),
  })
}

export const embedGraphDelta = Effect.fn("GraphEmbeddings.embedDelta")(function* (
  texts: ReadonlyArray<EmbeddingSourceText>,
): Effect.fn.Return<ReadonlyArray<EmbeddingVector>, EmbeddingProviderError, EmbeddingClient> {
  if (texts.length === 0) {
    return []
  }
  const client = yield* EmbeddingClient
  const normalizedAll: Array<EmbeddingVector> = []

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const chunk = texts.slice(i, i + EMBED_BATCH_SIZE)
    const rawBatch = yield* client.embedBatch(chunk)
    if (rawBatch.length !== chunk.length) {
      return yield* new EmbeddingProviderError({
        model: client.config.model,
        reason: ErrorReasonMessage.make(
          `Embedding provider returned ${rawBatch.length} vectors for ${chunk.length} inputs`,
        ),
      })
    }
    for (const rawVec of rawBatch) {
      const normalized = yield* normalizeAndValidateVector(
        rawVec,
        client.config.dimensions,
        client.config.model,
      )
      normalizedAll.push(normalized)
    }
  }

  return normalizedAll
})

const collectEmbeddableCandidates = (
  graph: HarnessGraph,
  model: EmbeddingModelId,
  dimensions: number,
): ReadonlyArray<EmbeddingSyncCandidateItem> => {
  const byKey = new Map<EmbeddingNodeKey, EmbeddingSyncCandidateItem>()

  const pushCandidate = (
    nodeKeyStr: string,
    nodeKind: EmbeddingNodeKind,
    rawText: string,
  ): void => {
    const trimmed = rawText.trim()
    if (trimmed.length === 0) return
    const nodeKey = EmbeddingNodeKey.make(nodeKeyStr)
    const contentHash = EmbeddingContentHash.make(
      sha256Hex(`${nodeKind}:${model}:${dimensions}:${trimmed}`),
    )
    byKey.set(nodeKey, {
      nodeKey,
      nodeKind,
      contentHash,
      sourceText: EmbeddingSourceText.make(trimmed),
    })
  }

  for (const [, node] of Graph.nodes(graph.graph)) {
    const key = getNodeKey(node)
    match(node)
      .with({ _tag: "PatternDoc" }, (p) => {
        pushCandidate(key, "PatternDoc", p.summary)
      })
      .with({ _tag: "AdrDoc" }, (adr) => {
        pushCandidate(key, "AdrDoc", adr.searchText ?? adr.summary ?? adr.title)
      })
      .with({ _tag: "EarsRequirement" }, (req) => {
        pushCandidate(key, "EarsRequirement", req.clauseText)
      })
      .with(
        { _tag: "EffectFn" },
        { _tag: "ServiceTag" },
        { _tag: "ServiceLayer" },
        { _tag: "TaggedError" },
        { _tag: "SchemaDef" },
        { _tag: "VitestCase" },
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

  return [...byKey.values()].sort((a, b) => compareCodeUnits(a.nodeKey, b.nodeKey))
}

const toVectorMap = (
  records: ReadonlyArray<EmbeddingVectorRecord>,
): ReadonlyMap<EmbeddingNodeKey, EmbeddingVector> => {
  const map = new Map<EmbeddingNodeKey, EmbeddingVector>()
  for (const r of records) {
    map.set(r.nodeKey, r.vector)
  }
  return map
}

export const syncGraphEmbeddings = Effect.fn("GraphEmbeddings.sync")(function* (
  input: GraphEmbeddingSyncInput,
): Effect.fn.Return<GraphEmbeddingSyncOutcome, never, EmbeddingClient | EmbeddingCachePort> {
  const client = yield* EmbeddingClient
  const cachePort = yield* EmbeddingCachePort
  const candidates = collectEmbeddableCandidates(
    input.graph,
    client.config.model,
    client.config.dimensions,
  )
  const candidateByKey = new Map<EmbeddingNodeKey, EmbeddingSyncCandidateItem>(
    candidates.map((c) => [c.nodeKey, c]),
  )

  const cachedOpt = yield* cachePort.readCache(input.repoRoot)
  const cachedSnapshot = Option.getOrNull(cachedOpt)
  const cachedByKey = new Map<EmbeddingNodeKey, EmbeddingVectorRecord>()
  if (cachedSnapshot !== null) {
    for (const entry of cachedSnapshot.entries) {
      cachedByKey.set(entry.nodeKey, entry)
    }
  }

  const plan = yield* input.decidePlan({
    currentModel: client.config.model,
    currentDimensions: client.config.dimensions,
    items: candidates,
    cachedSnapshot,
  })

  return yield* match(plan)
    .with({ _tag: "CacheHitAll" }, ({ reusedKeys }) => {
      const reusedRecords = reusedKeys
        .map((k) => cachedByKey.get(k))
        .filter((r): r is EmbeddingVectorRecord => r !== undefined)
      return Effect.succeed<GraphEmbeddingSyncOutcome>({
        mode: "hybrid-rrf",
        model: client.config.model,
        totalItems: NonNegativeCount.make(candidates.length),
        embeddedDeltaCount: NonNegativeCount.make(0),
        reusedCacheCount: NonNegativeCount.make(reusedRecords.length),
        degradedReason: null,
        vectorsByNodeKey: toVectorMap(reusedRecords),
      })
    })
    .with({ _tag: "EmbedDelta" }, { _tag: "ModelMismatchRebuild" }, (deltaPlan) =>
      Effect.gen(function* () {
        const reusedRecords: Array<EmbeddingVectorRecord> = match(deltaPlan)
          .with({ _tag: "EmbedDelta" }, (d) =>
            d.reusedKeys
              .map((k) => cachedByKey.get(k))
              .filter((r): r is EmbeddingVectorRecord => r !== undefined),
          )
          .with({ _tag: "ModelMismatchRebuild" }, () => [])
          .exhaustive()

        if (deltaPlan.embedKeys.length === 0) {
          const nowMs = yield* Clock.currentTimeMillis
          const prunedSnapshot: EmbeddingCacheSnapshot = {
            schemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
            model: client.config.model,
            dimensions: client.config.dimensions,
            updatedAt: EmbeddingBatchTimestamp.make(new Date(nowMs).toISOString()),
            entries: [...reusedRecords].sort((a, b) => compareCodeUnits(a.nodeKey, b.nodeKey)),
          }
          yield* cachePort.writeCache(input.repoRoot, prunedSnapshot)
          return {
            mode: "hybrid-rrf" as const,
            model: client.config.model,
            totalItems: NonNegativeCount.make(candidates.length),
            embeddedDeltaCount: NonNegativeCount.make(0),
            reusedCacheCount: NonNegativeCount.make(reusedRecords.length),
            degradedReason: null,
            vectorsByNodeKey: toVectorMap(reusedRecords),
          } satisfies GraphEmbeddingSyncOutcome
        }

        const availability = yield* client.checkAvailability
        const isAvailable = match(availability)
          .with("available", () => true)
          .with("unavailable", () => false)
          .exhaustive()

        if (!isAvailable) {
          return {
            mode: "bm25-only" as const,
            model: client.config.model,
            totalItems: NonNegativeCount.make(candidates.length),
            embeddedDeltaCount: NonNegativeCount.make(0),
            reusedCacheCount: NonNegativeCount.make(reusedRecords.length),
            degradedReason: ErrorReasonMessage.make(
              `Embedding provider unavailable for ${client.config.model}; operating in bm25-only mode`,
            ),
            vectorsByNodeKey: toVectorMap(reusedRecords),
          } satisfies GraphEmbeddingSyncOutcome
        }

        const itemsToEmbed = deltaPlan.embedKeys
          .map((k) => candidateByKey.get(k))
          .filter((c): c is EmbeddingSyncCandidateItem => c !== undefined)
        const embedExit = yield* Effect.exit(embedGraphDelta(itemsToEmbed.map((c) => c.sourceText)))

        return yield* match(embedExit)
          .with({ _tag: "Failure" }, ({ cause }) => {
            if (isPureInterruptCause(cause)) {
              return Effect.interrupt
            }
            const errOpt = Cause.findErrorOption(cause)
            const reasonText = match(errOpt)
              .with({ _tag: "Some" }, ({ value }) => value.reason)
              .with({ _tag: "None" }, () =>
                toErrorReasonMessage(Cause.squash(cause), "Embedding sync failed"),
              )
              .exhaustive()
            return Effect.succeed<GraphEmbeddingSyncOutcome>({
              mode: "bm25-only",
              model: client.config.model,
              totalItems: NonNegativeCount.make(candidates.length),
              embeddedDeltaCount: NonNegativeCount.make(0),
              reusedCacheCount: NonNegativeCount.make(reusedRecords.length),
              degradedReason: reasonText,
              vectorsByNodeKey: toVectorMap(reusedRecords),
            })
          })
          .with({ _tag: "Success" }, ({ value: vectors }) =>
            Effect.gen(function* () {
              const newlyEmbedded: Array<EmbeddingVectorRecord> = []
              for (let i = 0; i < itemsToEmbed.length; i++) {
                const item = itemsToEmbed[i]!
                const vector = vectors[i]!
                newlyEmbedded.push({
                  nodeKey: item.nodeKey,
                  nodeKind: item.nodeKind,
                  contentHash: item.contentHash,
                  dimensions: client.config.dimensions,
                  vector,
                })
              }
              const merged = [...reusedRecords, ...newlyEmbedded].sort((a, b) =>
                compareCodeUnits(a.nodeKey, b.nodeKey),
              )
              const nowMs = yield* Clock.currentTimeMillis
              const snapshot: EmbeddingCacheSnapshot = {
                schemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
                model: client.config.model,
                dimensions: client.config.dimensions,
                updatedAt: EmbeddingBatchTimestamp.make(new Date(nowMs).toISOString()),
                entries: merged,
              }
              yield* cachePort.writeCache(input.repoRoot, snapshot)
              return {
                mode: "hybrid-rrf" as const,
                model: client.config.model,
                totalItems: NonNegativeCount.make(candidates.length),
                embeddedDeltaCount: NonNegativeCount.make(newlyEmbedded.length),
                reusedCacheCount: NonNegativeCount.make(reusedRecords.length),
                degradedReason: null,
                vectorsByNodeKey: toVectorMap(merged),
              } satisfies GraphEmbeddingSyncOutcome
            }),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})
