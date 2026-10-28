import { Effect } from "effect"
import { match, P } from "ts-pattern"
import {
  AlbumQuotaExceededError,
  type CreatePhotoInput,
  type GreetInput
} from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"

export const greet = Effect.fn("Sample.greet")(function* (input: GreetInput) {
  yield* Effect.void
  return `Hello, ${input.name}!`
})

export const decideAlbumQuota = Effect.fn("Album.decide")(function* (input: {
  readonly albumId: string
  readonly currentCount: number
}) {
  return yield* match(input)
    .with({ currentCount: P.when((c) => c >= 100) }, ({ albumId, currentCount }) =>
      new AlbumQuotaExceededError({
        albumId,
        count: currentCount
      })
    )
    .otherwise(({ currentCount }) => Effect.succeed(currentCount + 1))
})

export const uploadPhoto = Effect.fn("Sample.uploadPhoto")(function* (input: CreatePhotoInput) {
  const counter = yield* AlbumCounterClient
  const repo = yield* PhotoRepo
  const currentCount = yield* counter.getCount(input.albumId)
  yield* decideAlbumQuota({ albumId: input.albumId, currentCount })
  yield* counter.increment(input.albumId)
  return yield* repo.insert(input)
})

export const getPhotoById = Effect.fn("Sample.getPhotoById")(function* (id: number) {
  const repo = yield* PhotoRepo
  return yield* repo.findById(id)
})

export const listPhotos = Effect.fn("Sample.listPhotos")(function* () {
  const repo = yield* PhotoRepo
  return yield* repo.listAll
})
