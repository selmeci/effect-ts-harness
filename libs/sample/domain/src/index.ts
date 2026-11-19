import { Effect } from "effect"
import { match, P } from "ts-pattern"
import {
  AlbumPhotoCount,
  AlbumQuotaExceededError,
  type CreatePhotoInput,
  type DecideAlbumQuotaInput,
  MAX_PHOTOS_PER_ALBUM,
  type PhotoId,
} from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"

export const decideAlbumQuota = Effect.fn("Album.decide")(function* (input: DecideAlbumQuotaInput) {
  return yield* match(input)
    .with(
      { currentCount: P.when((c) => c >= MAX_PHOTOS_PER_ALBUM) },
      ({ albumId, currentCount }) =>
        new AlbumQuotaExceededError({
          albumId,
          count: currentCount,
        }),
    )
    .otherwise(({ currentCount }) => Effect.succeed(AlbumPhotoCount.make(currentCount + 1)))
})

export const uploadPhoto = Effect.fn("Sample.uploadPhoto")(function* (input: CreatePhotoInput) {
  const counter = yield* AlbumCounterClient
  const repo = yield* PhotoRepo
  const currentCount = yield* counter.getCount(input.albumId)
  yield* decideAlbumQuota({ albumId: input.albumId, currentCount })
  return yield* Effect.acquireUseRelease(
    counter.increment(input.albumId),
    () => repo.insert(input),
    (_, exit) =>
      match(exit)
        .with({ _tag: "Success" }, () => Effect.void)
        .with({ _tag: "Failure" }, () => counter.decrement(input.albumId).pipe(Effect.catch(() => Effect.void)))
        .exhaustive(),
  )
})

export const getPhotoById = Effect.fn("Sample.getPhotoById")(function* (id: PhotoId) {
  const repo = yield* PhotoRepo
  return yield* repo.findById(id)
})

export const listPhotos = Effect.fn("Sample.listPhotos")(function* () {
  const repo = yield* PhotoRepo
  return yield* repo.listAll
})
