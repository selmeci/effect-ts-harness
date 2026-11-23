import { createHash } from "node:crypto"
import * as Graph from "effect/Graph"
import { Clock, Effect, Option } from "effect"
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
  MAX_EMBEDDING_SOURCE_TEXT_CHARS,
  NonNegativeCount,
  type WorkspaceFilePath,
} from "@harness/contract"
import { EmbeddingCachePort, type EmbeddingCachePortShape, EmbeddingClient } from "@harness/service"
import { firstNonBlank } from "./doc-tree.js"
import { type HarnessGraph, getNodeKey } from "./model.js"

const EMBED_BATCH_SIZE = 16

export interface GraphEmbeddingSyncInput {
  readonly graph: HarnessGraph
  readonly repoRoot: WorkspaceFilePath
  readonly decidePlan: (input: EmbeddingSyncPlanInput) => Effect.Effect<EmbeddingSyncPlanDecision>
}

export interface GraphEmbeddingSyncHybridOutcome {
  readonly mode: "hybrid-rrf"
  readonly model: EmbeddingModelId
  readonly totalItems: NonNegativeCount
  readonly embeddedDeltaCount: NonNegativeCount
  readonly reusedCacheCount: NonNegativeCount
  readonly degradedReason: null
  readonly vectorsByNodeKey: ReadonlyMap<EmbeddingNodeKey, EmbeddingVector>
}

export interface GraphEmbeddingSyncDegradedOutcome {
  readonly mode: "bm25-only"
  readonly model: EmbeddingModelId
  readonly totalItems: NonNegativeCount
  readonly embeddedDeltaCount: NonNegativeCount
  readonly reusedCacheCount: NonNegativeCount
  readonly degradedReason: ErrorReasonMessage
  readonly vectorsByNodeKey: ReadonlyMap<EmbeddingNodeKey, EmbeddingVector>
}

export type GraphEmbeddingSyncOutcome =
  | GraphEmbeddingSyncHybridOutcome
  | GraphEmbeddingSyncDegradedOutcome

const makeHybridSyncOutcome = (input: {
  readonly model: EmbeddingModelId
  readonly totalItems: number
  readonly embeddedDeltaCount: number
  readonly reusedCacheCount: number
  readonly vectorsByNodeKey: ReadonlyMap<EmbeddingNodeKey, EmbeddingVector>
}): GraphEmbeddingSyncHybridOutcome => ({
  mode: "hybrid-rrf",
  model: input.model,
  totalItems: NonNegativeCount.make(input.totalItems),
  embeddedDeltaCount: NonNegativeCount.make(input.embeddedDeltaCount),
  reusedCacheCount: NonNegativeCount.make(input.reusedCacheCount),
  degradedReason: null,
  vectorsByNodeKey: input.vectorsByNodeKey,
})

const makeDegradedSyncOutcome = (input: {
  readonly model: EmbeddingModelId
  readonly totalItems: number
  readonly embeddedDeltaCount: number
  readonly reusedCacheCount: number
  readonly degradedReason: ErrorReasonMessage
  readonly vectorsByNodeKey: ReadonlyMap<EmbeddingNodeKey, EmbeddingVector>
}): GraphEmbeddingSyncDegradedOutcome => ({
  mode: "bm25-only",
  model: input.model,
  totalItems: NonNegativeCount.make(input.totalItems),
  embeddedDeltaCount: NonNegativeCount.make(input.embeddedDeltaCount),
  reusedCacheCount: NonNegativeCount.make(input.reusedCacheCount),
  degradedReason: input.degradedReason,
  vectorsByNodeKey: input.vectorsByNodeKey,
})

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
    const trimmed = rawText.trim().slice(0, MAX_EMBEDDING_SOURCE_TEXT_CHARS).trim()
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
        pushCandidate(key, "AdrDoc", firstNonBlank(adr.searchText, adr.summary, adr.title))
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

const writeSnapshotHandlingError = (
  cachePort: EmbeddingCachePortShape,
  repoRoot: WorkspaceFilePath,
  records: ReadonlyArray<EmbeddingVectorRecord>,
  model: EmbeddingModelId,
  dimensions: EmbeddingVectorRecord["dimensions"],
): Effect.Effect<Option.Option<ErrorReasonMessage>> =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis
    const sortedEntries = [...records].sort((a, b) => compareCodeUnits(a.nodeKey, b.nodeKey))
    const snapshot: EmbeddingCacheSnapshot = {
      schemaVersion: EMBEDDING_CACHE_SCHEMA_VERSION,
      model,
      dimensions,
      updatedAt: EmbeddingBatchTimestamp.make(new Date(nowMs).toISOString()),
      entries: sortedEntries,
    }
    return yield* cachePort.writeCache(repoRoot, snapshot).pipe(
      Effect.as(Option.none<ErrorReasonMessage>()),
      Effect.catch((cacheErr) =>
        Effect.succeedSome(
          ErrorReasonMessage.make(
            `Embedding cache write failed (${cacheErr.kind}): ${cacheErr.reason}`,
          ),
        ),
      ),
    )
  })

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

  type CacheReadResolution =
    | { readonly _tag: "Continue"; readonly cachedSnapshot: EmbeddingCacheSnapshot | null }
    | { readonly _tag: "Degrade"; readonly outcome: GraphEmbeddingSyncDegradedOutcome }

  const readResolution: CacheReadResolution = yield* cachePort.readCache(input.repoRoot).pipe(
    Effect.map((cachedOpt): CacheReadResolution => ({
      _tag: "Continue",
      cachedSnapshot: Option.getOrNull(cachedOpt),
    })),
    Effect.catch((cacheErr): Effect.Effect<CacheReadResolution> =>
      match(cacheErr.kind)
        .with("corrupt-snapshot", () => {
          process.stderr.write(
            `[harness:embedding-sync] Warning: corrupt embedding cache at ${cacheErr.path}; rebuilding (${cacheErr.reason})\n`,
          )
          return Effect.succeed<CacheReadResolution>({
            _tag: "Continue",
            cachedSnapshot: null,
          })
        })
        .with("symlink-refused", "boundary-escape", "invalid-state-dir", "io-error", () =>
          Effect.succeed<CacheReadResolution>({
            _tag: "Degrade",
            outcome: makeDegradedSyncOutcome({
              model: client.config.model,
              totalItems: candidates.length,
              embeddedDeltaCount: 0,
              reusedCacheCount: 0,
              degradedReason: ErrorReasonMessage.make(
                `Embedding cache read failed (${cacheErr.kind}): ${cacheErr.reason}`,
              ),
              vectorsByNodeKey: new Map(),
            }),
          }),
        )
        .exhaustive(),
    ),
  )

  return yield* match(readResolution)
    .with({ _tag: "Degrade" }, ({ outcome }) => Effect.succeed<GraphEmbeddingSyncOutcome>(outcome))
    .with({ _tag: "Continue" }, ({ cachedSnapshot }) =>
      Effect.gen(function* () {
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
            if (
              reusedRecords.length !== reusedKeys.length ||
              reusedRecords.length !== candidates.length
            ) {
              return Effect.succeed(
                makeDegradedSyncOutcome({
                  model: client.config.model,
                  totalItems: candidates.length,
                  embeddedDeltaCount: 0,
                  reusedCacheCount: reusedRecords.length,
                  degradedReason: ErrorReasonMessage.make(
                    `Embedding cache hit integrity mismatch: expected ${candidates.length} vectors, resolved ${reusedRecords.length} of ${reusedKeys.length} reused keys`,
                  ),
                  vectorsByNodeKey: toVectorMap(reusedRecords),
                }),
              )
            }
            return Effect.succeed(
              makeHybridSyncOutcome({
                model: client.config.model,
                totalItems: candidates.length,
                embeddedDeltaCount: 0,
                reusedCacheCount: reusedRecords.length,
                vectorsByNodeKey: toVectorMap(reusedRecords),
              }),
            )
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
                const writeErrOpt = yield* writeSnapshotHandlingError(
                  cachePort,
                  input.repoRoot,
                  reusedRecords,
                  client.config.model,
                  client.config.dimensions,
                )
                return match(writeErrOpt)
                  .with({ _tag: "Some" }, ({ value: degradedReason }) =>
                    makeDegradedSyncOutcome({
                      model: client.config.model,
                      totalItems: candidates.length,
                      embeddedDeltaCount: 0,
                      reusedCacheCount: reusedRecords.length,
                      degradedReason,
                      vectorsByNodeKey: toVectorMap(reusedRecords),
                    }),
                  )
                  .with({ _tag: "None" }, () =>
                    makeHybridSyncOutcome({
                      model: client.config.model,
                      totalItems: candidates.length,
                      embeddedDeltaCount: 0,
                      reusedCacheCount: reusedRecords.length,
                      vectorsByNodeKey: toVectorMap(reusedRecords),
                    }),
                  )
                  .exhaustive()
              }

              const availability = yield* client.checkAvailability
              const unavailableReason = match(availability)
                .with({ _tag: "Available" }, () => null)
                .with({ _tag: "Unavailable" }, ({ cause, reason }) =>
                  ErrorReasonMessage.make(
                    `Embedding provider unavailable for ${client.config.model} (${cause}): ${reason}`,
                  ),
                )
                .exhaustive()

              if (unavailableReason !== null) {
                return makeDegradedSyncOutcome({
                  model: client.config.model,
                  totalItems: candidates.length,
                  embeddedDeltaCount: 0,
                  reusedCacheCount: reusedRecords.length,
                  degradedReason: unavailableReason,
                  vectorsByNodeKey: toVectorMap(reusedRecords),
                })
              }

              const itemsToEmbed = deltaPlan.embedKeys
                .map((k) => candidateByKey.get(k))
                .filter((c): c is EmbeddingSyncCandidateItem => c !== undefined)
              const newlyEmbedded: Array<EmbeddingVectorRecord> = []

              for (let i = 0; i < itemsToEmbed.length; i += EMBED_BATCH_SIZE) {
                const chunkItems = itemsToEmbed.slice(i, i + EMBED_BATCH_SIZE)
                const chunkStep = yield* embedGraphDelta(chunkItems.map((c) => c.sourceText)).pipe(
                  Effect.map((vectors) => ({ _tag: "Vectors" as const, vectors })),
                  Effect.catch((providerErr) =>
                    Effect.succeed({ _tag: "Degrade" as const, reason: providerErr.reason }),
                  ),
                )

                const batchFailure = match(chunkStep)
                  .with({ _tag: "Degrade" }, ({ reason }) => reason)
                  .with({ _tag: "Vectors" }, ({ vectors }) => {
                    for (let j = 0; j < chunkItems.length; j++) {
                      const item = chunkItems[j]!
                      const vector = vectors[j]!
                      newlyEmbedded.push({
                        nodeKey: item.nodeKey,
                        nodeKind: item.nodeKind,
                        contentHash: item.contentHash,
                        dimensions: client.config.dimensions,
                        vector,
                      })
                    }
                    return null
                  })
                  .exhaustive()

                if (batchFailure !== null) {
                  return makeDegradedSyncOutcome({
                    model: client.config.model,
                    totalItems: candidates.length,
                    embeddedDeltaCount: newlyEmbedded.length,
                    reusedCacheCount: reusedRecords.length,
                    degradedReason: batchFailure,
                    vectorsByNodeKey: toVectorMap([...reusedRecords, ...newlyEmbedded]),
                  })
                }

                const mergedSoFar = [...reusedRecords, ...newlyEmbedded]
                const writeErrOpt = yield* writeSnapshotHandlingError(
                  cachePort,
                  input.repoRoot,
                  mergedSoFar,
                  client.config.model,
                  client.config.dimensions,
                )
                const writeFailure = match(writeErrOpt)
                  .with({ _tag: "Some" }, ({ value }) => value)
                  .with({ _tag: "None" }, () => null)
                  .exhaustive()
                if (writeFailure !== null) {
                  return makeDegradedSyncOutcome({
                    model: client.config.model,
                    totalItems: candidates.length,
                    embeddedDeltaCount: newlyEmbedded.length,
                    reusedCacheCount: reusedRecords.length,
                    degradedReason: writeFailure,
                    vectorsByNodeKey: toVectorMap(mergedSoFar),
                  })
                }
              }

              return makeHybridSyncOutcome({
                model: client.config.model,
                totalItems: candidates.length,
                embeddedDeltaCount: newlyEmbedded.length,
                reusedCacheCount: reusedRecords.length,
                vectorsByNodeKey: toVectorMap([...reusedRecords, ...newlyEmbedded]),
              })
            }),
          )
          .exhaustive()
      }),
    )
    .exhaustive()
})
