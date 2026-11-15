import { Context, type Effect } from "effect"
import type {
  AlbumCounterProtocolError,
  AlbumCounterStorageError,
  AlbumId,
  AlbumPhotoCount,
  AlbumQuotaExceededError,
  CreatePhotoInput,
  Photo,
  PhotoId,
  PhotoNotFoundError,
  PhotoStorageError,
} from "@harness/sample-contract"

export class PhotoRepo extends Context.Service<
  PhotoRepo,
  {
    readonly insert: (input: CreatePhotoInput) => Effect.Effect<Photo, PhotoStorageError>
    readonly findById: (
      id: PhotoId,
    ) => Effect.Effect<Photo, PhotoNotFoundError | PhotoStorageError>
    readonly listAll: Effect.Effect<ReadonlyArray<Photo>, PhotoStorageError>
  }
>()("PhotoRepo") {}

export class AlbumCounterClient extends Context.Service<
  AlbumCounterClient,
  {
    readonly increment: (
      albumId: AlbumId,
    ) => Effect.Effect<
      AlbumPhotoCount,
      AlbumQuotaExceededError | AlbumCounterStorageError | AlbumCounterProtocolError
    >
    readonly decrement: (
      albumId: AlbumId,
    ) => Effect.Effect<
      AlbumPhotoCount,
      AlbumCounterStorageError | AlbumCounterProtocolError
    >
    readonly getCount: (
      albumId: AlbumId,
    ) => Effect.Effect<
      AlbumPhotoCount,
      AlbumCounterStorageError | AlbumCounterProtocolError
    >
  }
>()("AlbumCounterClient") {}

export const AlbumCounterStoreTypeId: unique symbol = Symbol.for(
  "@harness/sample-service/AlbumCounterStore",
)
export type AlbumCounterStoreTypeId = typeof AlbumCounterStoreTypeId

export interface AlbumCounterStore {
  readonly [AlbumCounterStoreTypeId]: AlbumCounterStoreTypeId
  readonly get: (albumId: AlbumId) => Effect.Effect<AlbumPhotoCount, AlbumCounterStorageError>
  readonly set: (
    albumId: AlbumId,
    count: AlbumPhotoCount,
  ) => Effect.Effect<void, AlbumCounterStorageError>
  readonly incrementWithQuota: (
    albumId: AlbumId,
  ) => Effect.Effect<AlbumPhotoCount, AlbumQuotaExceededError | AlbumCounterStorageError>
  readonly decrement: (
    albumId: AlbumId,
  ) => Effect.Effect<AlbumPhotoCount, AlbumCounterStorageError>
}

export class ActiveCounterStore extends Context.Service<ActiveCounterStore, AlbumCounterStore>()(
  "SampleInfra.ActiveCounterStore",
) {}
