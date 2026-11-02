import { Context, type Effect } from "effect"
import type {
  AlbumId,
  AlbumPhotoCount,
  AlbumQuotaExceededError,
  CreatePhotoInput,
  Photo,
  PhotoId,
  PhotoNotFoundError,
} from "@harness/sample-contract"

export class PhotoRepo extends Context.Service<
  PhotoRepo,
  {
    readonly insert: (input: CreatePhotoInput) => Effect.Effect<Photo>
    readonly findById: (id: PhotoId) => Effect.Effect<Photo, PhotoNotFoundError>
    readonly listAll: Effect.Effect<ReadonlyArray<Photo>>
  }
>()("PhotoRepo") {}

export class AlbumCounterClient extends Context.Service<
  AlbumCounterClient,
  {
    readonly increment: (
      albumId: AlbumId,
    ) => Effect.Effect<AlbumPhotoCount, AlbumQuotaExceededError>
    readonly getCount: (albumId: AlbumId) => Effect.Effect<AlbumPhotoCount>
  }
>()("AlbumCounterClient") {}
