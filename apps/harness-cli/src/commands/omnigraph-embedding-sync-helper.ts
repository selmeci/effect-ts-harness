import { Effect, Layer } from "effect"
import { match } from "ts-pattern"
import { ErrorReasonMessage, WorkspaceFilePath } from "@harness/contract"
import {
  collectSemanticConflictCandidates,
  type CollectSemanticConflictCandidatesResult,
  type OntologyConflictInput,
} from "@harness/decision"
import { decideEmbeddingSyncPlan, type GovernanceDocReference } from "@harness/gates"
import { type HarnessGraph, syncGraphEmbeddings } from "@harness/graph"
import { FileEmbeddingCacheLive, OllamaEmbeddingClientLive } from "@harness/infra"
import type { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import { isIsolatedExternalWorkspace } from "./daemon-and-omnigraph.service.js"

export interface SyncEmbeddingHelperOptions {
  readonly skipBackgroundDaemons?: boolean | undefined
  readonly embeddingClientLayer?: Layer.Layer<EmbeddingClient> | undefined
  readonly embeddingCacheLayer?: Layer.Layer<EmbeddingCachePort> | undefined
}

export type ComputeGraphEmbeddingsResult =
  | {
      readonly _tag: "Ready"
      readonly vectorsByNodeKey: ReadonlyMap<string, ReadonlyArray<number>>
    }
  | {
      readonly _tag: "Degraded"
      readonly vectorsByNodeKey: ReadonlyMap<string, ReadonlyArray<number>>
      readonly reason: ErrorReasonMessage
    }
  | {
      readonly _tag: "Skipped"
      readonly reason: string
    }

export const toSyncEmbeddingOptions = (
  result: ComputeGraphEmbeddingsResult,
): {
  readonly embeddingsByNodeKey?: ReadonlyMap<string, ReadonlyArray<number>> | undefined
  readonly clearMissingEmbeddings?: boolean | undefined
} =>
  match(result)
    .with({ _tag: "Ready" }, ({ vectorsByNodeKey }) => ({
      embeddingsByNodeKey: vectorsByNodeKey,
      clearMissingEmbeddings: true,
    }))
    .with({ _tag: "Degraded" }, ({ vectorsByNodeKey }) =>
      vectorsByNodeKey.size > 0
        ? {
            embeddingsByNodeKey: vectorsByNodeKey,
            clearMissingEmbeddings: false,
          }
        : {},
    )
    .with({ _tag: "Skipped" }, () => ({}))
    .exhaustive()

export const computeSyncEmbeddingsForGraph = (
  repoRoot: string,
  graph: HarnessGraph,
  options?: SyncEmbeddingHelperOptions,
): Effect.Effect<ComputeGraphEmbeddingsResult> => {
  if (options?.skipBackgroundDaemons === true && options?.embeddingClientLayer === undefined) {
    return Effect.succeed({
      _tag: "Skipped" as const,
      reason: "Background daemons skipped",
    })
  }
  if (isIsolatedExternalWorkspace(repoRoot) && options?.embeddingClientLayer === undefined) {
    return Effect.succeed({
      _tag: "Skipped" as const,
      reason: "Isolated external workspace",
    })
  }
  const clientLayer = options?.embeddingClientLayer ?? OllamaEmbeddingClientLive
  const cacheLayer = options?.embeddingCacheLayer ?? FileEmbeddingCacheLive

  return syncGraphEmbeddings({
    graph,
    repoRoot: WorkspaceFilePath.make(repoRoot),
    decidePlan: decideEmbeddingSyncPlan,
  }).pipe(
    Effect.provide(Layer.mergeAll(clientLayer, cacheLayer)),
    Effect.map((outcome): ComputeGraphEmbeddingsResult => {
      const vectors = new Map<string, ReadonlyArray<number>>()
      for (const [nodeKey, vec] of outcome.vectorsByNodeKey) {
        vectors.set(nodeKey, vec.components)
      }
      return match(outcome)
        .with({ mode: "hybrid-rrf" }, () => ({
          _tag: "Ready" as const,
          vectorsByNodeKey: vectors,
        }))
        .with({ mode: "bm25-only" }, ({ degradedReason }) => {
          process.stderr.write(`[harness:embeddings] Degraded to bm25-only: ${degradedReason}\n`)
          return {
            _tag: "Degraded" as const,
            vectorsByNodeKey: vectors,
            reason: degradedReason,
          }
        })
        .exhaustive()
    }),
  )
}

export const extractSemanticCandidateConflictPairs = (
  repoRoot: string,
  graph: HarnessGraph,
  docs: ReadonlyArray<GovernanceDocReference>,
  existingPairs: ReadonlyArray<OntologyConflictInput>,
  options?: SyncEmbeddingHelperOptions,
): Effect.Effect<CollectSemanticConflictCandidatesResult> => {
  if (docs.length === 0) {
    return Effect.succeed({ pairs: [], degraded: false, degradedReason: null })
  }
  if (options?.skipBackgroundDaemons === true && options?.embeddingClientLayer === undefined) {
    return Effect.succeed({ pairs: [], degraded: false, degradedReason: null })
  }
  const clientLayer = options?.embeddingClientLayer ?? OllamaEmbeddingClientLive
  const cacheLayer = options?.embeddingCacheLayer ?? FileEmbeddingCacheLive
  return collectSemanticConflictCandidates({
    repoRoot: WorkspaceFilePath.make(repoRoot),
    graph,
    docs,
    existingPairs,
  }).pipe(Effect.provide(Layer.mergeAll(clientLayer, cacheLayer)))
}
