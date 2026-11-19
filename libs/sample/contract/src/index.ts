import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Rpc, RpcGroup } from "effect/rpc"

// Branded Domain Value Schemas
export const GreetingMessage = Schema.String.pipe(Schema.brand("GreetingMessage"))
export type GreetingMessage = typeof GreetingMessage.Type

export const PhotoId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PhotoId"))
export type PhotoId = typeof PhotoId.Type

export const PhotoIdFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(PhotoId))
export type PhotoIdFromString = typeof PhotoIdFromString.Type

export const PhotoName = Schema.String.pipe(Schema.brand("PhotoName"))
export type PhotoName = typeof PhotoName.Type

export const AlbumId = Schema.String.pipe(Schema.brand("AlbumId"))
export type AlbumId = typeof AlbumId.Type

export const CreatedAtMillis = Schema.Int.pipe(Schema.brand("CreatedAtMillis"))
export type CreatedAtMillis = typeof CreatedAtMillis.Type

export const AlbumPhotoCount = Schema.Natural.pipe(Schema.brand("AlbumPhotoCount"))
export type AlbumPhotoCount = typeof AlbumPhotoCount.Type

export const MAX_PHOTOS_PER_ALBUM: AlbumPhotoCount = AlbumPhotoCount.make(100)

export const StorageOperationName = Schema.String.pipe(Schema.brand("StorageOperationName"))
export type StorageOperationName = typeof StorageOperationName.Type

export const StorageErrorMessage = Schema.String.pipe(Schema.brand("StorageErrorMessage"))
export type StorageErrorMessage = typeof StorageErrorMessage.Type

export const HttpStatusCode = Schema.Int.pipe(Schema.brand("HttpStatusCode"))
export type HttpStatusCode = typeof HttpStatusCode.Type

export const ProtocolErrorMessage = Schema.String.pipe(Schema.brand("ProtocolErrorMessage"))
export type ProtocolErrorMessage = typeof ProtocolErrorMessage.Type

export const DecideAlbumQuotaInput = Schema.Struct({
  albumId: AlbumId,
  currentCount: AlbumPhotoCount,
})
export type DecideAlbumQuotaInput = typeof DecideAlbumQuotaInput.Type

// Schemas
export const Photo = Schema.Struct({
  id: PhotoId,
  name: PhotoName,
  albumId: AlbumId,
  createdAt: CreatedAtMillis,
})
export type Photo = typeof Photo.Type

export const CreatePhotoInput = Schema.Struct({
  name: PhotoName,
  albumId: AlbumId,
})
export type CreatePhotoInput = typeof CreatePhotoInput.Type

// Tagged Errors
export class PhotoNotFoundError extends Schema.TaggedError<PhotoNotFoundError>()(
  "PhotoNotFoundError",
  { id: PhotoId },
) {}

export class AlbumQuotaExceededError extends Schema.TaggedError<AlbumQuotaExceededError>()(
  "AlbumQuotaExceededError",
  { albumId: AlbumId, count: AlbumPhotoCount },
) {}

export class AlbumCounterStorageError extends Schema.TaggedError<AlbumCounterStorageError>()(
  "AlbumCounterStorageError",
  { operation: StorageOperationName, message: StorageErrorMessage },
) {}

export class AlbumCounterProtocolError extends Schema.TaggedError<AlbumCounterProtocolError>()(
  "AlbumCounterProtocolError",
  { status: HttpStatusCode, message: ProtocolErrorMessage },
) {}

export class PhotoStorageError extends Schema.TaggedError<PhotoStorageError>()(
  "PhotoStorageError",
  { operation: StorageOperationName, message: StorageErrorMessage },
) {}

// HttpApi Group & API
export const PhotosApiGroup = HttpApiGroup.make("photos").add(
  HttpApiEndpoint.get("listPhotos", "/photos", {
    success: Schema.Array(Photo),
  }),
  HttpApiEndpoint.post("createPhoto", "/photos", {
    payload: CreatePhotoInput,
    success: Photo,
    error: AlbumQuotaExceededError,
  }),
  HttpApiEndpoint.get("getPhoto", "/photos/:id", {
    params: Schema.Struct({ id: PhotoIdFromString }),
    success: Photo,
    error: PhotoNotFoundError,
  }),
)

export const SampleApi = HttpApi.make("SampleApi").add(PhotosApiGroup)
export type SampleApi = typeof SampleApi

export const buildOpenApiSpec = (): unknown => OpenApi.fromApi(SampleApi)

// RpcGroup
export const IncrementAlbumCount = Rpc.make("IncrementAlbumCount", {
  payload: Schema.Struct({ albumId: AlbumId }),
  success: AlbumPhotoCount,
  error: AlbumQuotaExceededError,
})
export type IncrementAlbumCount = typeof IncrementAlbumCount

export const GetAlbumCount = Rpc.make("GetAlbumCount", {
  payload: Schema.Struct({ albumId: AlbumId }),
  success: AlbumPhotoCount,
})
export type GetAlbumCount = typeof GetAlbumCount

export const DecrementAlbumCount = Rpc.make("DecrementAlbumCount", {
  payload: Schema.Struct({ albumId: AlbumId }),
  success: AlbumPhotoCount,
})
export type DecrementAlbumCount = typeof DecrementAlbumCount

export const PhotoCounterRpc = RpcGroup.make(
  IncrementAlbumCount,
  GetAlbumCount,
  DecrementAlbumCount,
)
export type PhotoCounterRpc = typeof PhotoCounterRpc
