import { Context, type Effect, type Option } from "effect"
import type {
  EmbeddingCacheSnapshot,
  EmbeddingProviderAvailability,
  EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingSourceText,
  EmbeddingVector,
  KnowledgeQueryText,
  WorkspaceFilePath,
} from "@harness/contract"

export interface EmbeddingClientShape {
  readonly config: EmbeddingProviderConfig
  readonly checkAvailability: Effect.Effect<EmbeddingProviderAvailability>
  readonly embedBatch: (
    texts: ReadonlyArray<EmbeddingSourceText>,
  ) => Effect.Effect<ReadonlyArray<EmbeddingVector>, EmbeddingProviderError>
  readonly embedQuery: (
    query: KnowledgeQueryText,
  ) => Effect.Effect<EmbeddingVector, EmbeddingProviderError>
}

export class EmbeddingClient extends Context.Service<EmbeddingClient, EmbeddingClientShape>()(
  "@harness/service/EmbeddingClient",
) {}

export interface EmbeddingCachePortShape {
  readonly readCache: (
    repoRoot: WorkspaceFilePath,
  ) => Effect.Effect<Option.Option<EmbeddingCacheSnapshot>>
  readonly writeCache: (
    repoRoot: WorkspaceFilePath,
    snapshot: EmbeddingCacheSnapshot,
  ) => Effect.Effect<void>
}

export class EmbeddingCachePort extends Context.Service<
  EmbeddingCachePort,
  EmbeddingCachePortShape
>()("@harness/service/EmbeddingCachePort") {}
