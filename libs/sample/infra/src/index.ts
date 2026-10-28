import {
  Context,
  Effect,
  Layer,
  type Option,
  Ref,
  Scheduler,
  Schema,
  Tracer
} from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { eq } from "drizzle-orm"
import { match, P } from "ts-pattern"
import {
  AlbumQuotaExceededError,
  type CreatePhotoInput,
  GetAlbumCount,
  IncrementAlbumCount,
  Photo,
  PhotoCounterRpc,
  PhotoNotFoundError
} from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"
import { decideAlbumQuota } from "@harness/sample-domain"
import { albumCounters, photos } from "./db/schema.js"

export { albumCounters, photos } from "./db/schema.js"

export const logToConsole = Effect.fn("Sample.logToConsole")(function* (message: string) {
  yield* Effect.sync(() => {
    console.log(message)
  })
})

// PhotoRepo In-Memory Layer
export const PhotoRepoMemoryLayer: Layer.Layer<PhotoRepo> = Layer.effect(
  PhotoRepo,
  Effect.gen(function* () {
    const itemsRef = yield* Ref.make<ReadonlyArray<Photo>>([])
    let nextId = 1

    const insert = Effect.fn("PhotoRepo.insert")(
      (input: CreatePhotoInput): Effect.Effect<Photo> =>
        Effect.gen(function* () {
          const raw = {
            id: nextId++,
            name: input.name,
            albumId: input.albumId,
            createdAt: Math.floor(Date.now())
          }
          const photo = yield* Schema.decodeEffect(Photo)(raw).pipe(Effect.orDie)
          yield* Ref.update(itemsRef, (items) => [...items, photo])
          return photo
        })
    )

    const findById = Effect.fn("PhotoRepo.findById")(
      (id: number): Effect.Effect<Photo, PhotoNotFoundError> =>
        Effect.gen(function* () {
          const items = yield* Ref.get(itemsRef)
          const found = items.find((p) => p.id === id)
          if (!found) {
            return yield* new PhotoNotFoundError({ id })
          }
          return found
        })
    )

    const listAll: Effect.Effect<ReadonlyArray<Photo>> = Ref.get(itemsRef).pipe(
      Effect.withSpan("PhotoRepo.listAll")
    )

    return PhotoRepo.of({ insert, findById, listAll })
  })
)

// PhotoRepo D1 / SQLite Layer Factory
export interface DrizzleDatabase {
  readonly insert: (table: any) => {
    readonly values: (value: any) => any
  }
  readonly select: () => {
    readonly from: (table: any) => any
  }
}

const _makePhotoRepoDrizzle = (db: DrizzleDatabase) => {
  const insert = Effect.fn("PhotoRepo.insert")(
    (input: CreatePhotoInput): Effect.Effect<Photo> =>
      Effect.gen(function* () {
        const createdAt = Math.floor(Date.now())
        const insertEffect = (db
          .insert(photos)
          .values({
            name: input.name,
            albumId: input.albumId,
            createdAt
          })
          .returning()) as unknown as Effect.Effect<ReadonlyArray<unknown>, Error, never>

        const rows = yield* insertEffect
        return yield* Schema.decodeUnknownEffect(Photo)(rows[0])
      }).pipe(Effect.orDie)
  )

  const findById = Effect.fn("PhotoRepo.findById")(
    (id: number): Effect.Effect<Photo, PhotoNotFoundError> =>
      Effect.gen(function* () {
        const selectEffect = (db
          .select()
          .from(photos)
          .where(eq(photos.id, id))) as unknown as Effect.Effect<ReadonlyArray<unknown>, Error, never>
        const rows = yield* Effect.orDie(selectEffect)
        if (!rows || rows.length === 0) {
          return yield* new PhotoNotFoundError({ id })
        }
        return yield* Schema.decodeUnknownEffect(Photo)(rows[0]).pipe(Effect.orDie)
      })
  )

  const listAll: Effect.Effect<ReadonlyArray<Photo>> = Effect.gen(function* () {
    const selectEffect = (db
      .select()
      .from(photos)) as unknown as Effect.Effect<ReadonlyArray<unknown>, Error, never>
    const rows = yield* selectEffect
    return yield* Schema.decodeUnknownEffect(Schema.Array(Photo))(rows ?? [])
  }).pipe(Effect.orDie, Effect.withSpan("PhotoRepo.listAll"))

  return PhotoRepo.of({ insert, findById, listAll })
}

const _makePhotoRepoD1Layer = (db: DrizzleDatabase): Layer.Layer<PhotoRepo> =>
  Layer.succeed(PhotoRepo, _makePhotoRepoDrizzle(db))

export {
  _makePhotoRepoDrizzle as makePhotoRepoDrizzle,
  _makePhotoRepoD1Layer as makePhotoRepoD1Layer
}

// AlbumCounter Store Interface & Implementation
export interface AlbumCounterStore {
  readonly get: (albumId: string) => Effect.Effect<number>
  readonly set: (albumId: string, count: number) => Effect.Effect<void>
}

export class ActiveCounterStore extends Context.Service<ActiveCounterStore, AlbumCounterStore>()(
  "SampleInfra.ActiveCounterStore"
) {}

const _makeAlbumCounterStoreMemory = (initial: Record<string, number> = {}): AlbumCounterStore => {
  const map = new Map<string, number>(Object.entries(initial))
  return {
    get: (albumId: string) => Effect.sync(() => map.get(albumId) ?? 0),
    set: (albumId: string, count: number) =>
      Effect.sync(() => {
        map.set(albumId, count)
      })
  }
}

export const AlbumCounterStoreMemoryLayer: Layer.Layer<ActiveCounterStore> = Layer.sync(
  ActiveCounterStore,
  () => _makeAlbumCounterStoreMemory()
)

const _makeAlbumCounterStoreDrizzle = (db: DrizzleDatabase): AlbumCounterStore => ({
  get: (albumId: string) =>
    Effect.gen(function* () {
      const selectEffect = (db
        .select()
        .from(albumCounters)
        .where(eq(albumCounters.albumId, albumId))) as unknown as Effect.Effect<
        ReadonlyArray<{ albumId: string; count: number }>,
        Error,
        never
      >
      const rows = yield* Effect.orDie(selectEffect)
      if (!rows || rows.length === 0 || rows[0] == null) {
        return 0
      }
      return rows[0].count
    }),
  set: (albumId: string, count: number) =>
    Effect.gen(function* () {
      const upsertEffect = (db
        .insert(albumCounters)
        .values({ albumId, count })
        .onConflictDoUpdate({
          target: albumCounters.albumId,
          set: { count }
        })) as unknown as Effect.Effect<unknown, Error, never>
      yield* Effect.orDie(upsertEffect)
    })
})

const _makeAlbumCounterDoLayer = (db: DrizzleDatabase): Layer.Layer<ActiveCounterStore> =>
  Layer.succeed(ActiveCounterStore, _makeAlbumCounterStoreDrizzle(db))

const incrementRpcDef = PhotoCounterRpc.requests.get(
  "IncrementAlbumCount"
) as typeof IncrementAlbumCount
const getRpcDef = PhotoCounterRpc.requests.get("GetAlbumCount") as typeof GetAlbumCount

const formatTraceparent = (maybeSpan: Option.Option<Tracer.AnySpan>): string | undefined =>
  match(maybeSpan)
    .with({ _tag: "Some" }, ({ value }) => `00-${value.traceId}-${value.spanId}-01`)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

export const handleAlbumCounterRpc = Effect.fn("SampleInfra.handleAlbumCounterRpc")(
  function* (rawInput: unknown) {
    const rawAction =
      rawInput != null && typeof rawInput === "object" && "action" in rawInput
        ? String((rawInput as any).action)
        : "IncrementAlbumCount"

    const isGet = rawAction === "GetAlbumCount"
    const rpcDef = isGet ? getRpcDef : incrementRpcDef

    // 1. Pre-validation and Schema decoding outside synchronous transaction using RpcGroup schema
    const payload = yield* Schema.decodeUnknownEffect(rpcDef.payloadSchema)(rawInput)

    const maybeStore = yield* Effect.serviceOption(ActiveCounterStore)
    const store = match(maybeStore)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => _makeAlbumCounterStoreMemory())
      .exhaustive()

    // 2. Synchronous DO transaction discipline
    return yield* Effect.gen(function* () {
      if (isGet) {
        return yield* store.get(payload.albumId)
      }

      const currentCount = yield* store.get(payload.albumId)
      const nextCount = yield* decideAlbumQuota({
        albumId: payload.albumId,
        currentCount
      })
      yield* store.set(payload.albumId, nextCount)
      return nextCount
    }).pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")))
  }
)

const _toHttpClient = (fetcher: {
  readonly fetch: (
    request: HttpServerRequest.HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Error, never>
}): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const serverReq = HttpServerRequest.fromClientRequest(request)
      const res = yield* fetcher.fetch(serverReq)
      return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(res))
    }).pipe(Effect.orDie)
  )

export { _toHttpClient as toHttpClient }

const isServerRequest = (req: unknown): req is HttpServerRequest.HttpServerRequest =>
  req != null && typeof req === "object" && HttpServerRequest.TypeId in req

const _makeAlbumCounterRpcHandler = (
  storeOrDb?: AlbumCounterStore | DrizzleDatabase
): {
  readonly fetch: (
    request: HttpServerRequest.HttpServerRequest | Request
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>
} => {
  const localStore: AlbumCounterStore = match(storeOrDb)
    .with(
      P.when((s): s is AlbumCounterStore => s != null && "get" in s && "set" in s),
      (s) => s
    )
    .with(
      P.when((s): s is DrizzleDatabase => s != null && "insert" in s && "select" in s),
      (db) => _makeAlbumCounterStoreDrizzle(db)
    )
    .otherwise(() => _makeAlbumCounterStoreMemory())

  return {
    fetch: (
      request: HttpServerRequest.HttpServerRequest | Request
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
      Effect.gen(function* () {
        let traceparentHeader: string | undefined
        let rawBody: unknown

        if (isServerRequest(request)) {
          traceparentHeader = request.headers["traceparent"]
          rawBody = yield* Effect.orDie(request.json)
        } else {
          const req = request as Request
          traceparentHeader = req.headers.get("traceparent") ?? undefined
          rawBody = yield* Effect.orDie(Effect.promise(() => req.json()))
        }

        let externalSpan: Tracer.ExternalSpan | undefined
        if (typeof traceparentHeader === "string") {
          const parsedTrace = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(
            traceparentHeader.trim()
          )
          if (parsedTrace && parsedTrace[1] && parsedTrace[2]) {
            externalSpan = Tracer.externalSpan({
              traceId: parsedTrace[1],
              spanId: parsedTrace[2],
              sampled: true
            })
          }
        }

        let handler = handleAlbumCounterRpc(rawBody).pipe(
          Effect.provideService(ActiveCounterStore, localStore)
        )
        if (externalSpan) {
          handler = Effect.withParentSpan(handler, externalSpan)
        }

        const res = yield* handler.pipe(
          Effect.map((count) => ({ _tag: "Success" as const, count })),
          Effect.catch((err: unknown) => Effect.succeed({ _tag: "Failure" as const, err }))
        )

        return yield* match(res)
          .with({ _tag: "Success" }, ({ count }) =>
            Effect.gen(function* () {
              const encodedCount = yield* Schema.encodeUnknownEffect(
                incrementRpcDef.successSchema
              )(count)
              return yield* HttpServerResponse.json({ count: encodedCount })
            })
          )
          .with(
            {
              _tag: "Failure",
              err: P.when(
                (failure): failure is AlbumQuotaExceededError =>
                  failure != null &&
                  typeof failure === "object" &&
                  "_tag" in failure &&
                  failure._tag === "AlbumQuotaExceededError"
              )
            },
            ({ err }) =>
              Effect.gen(function* () {
                const encodedErr = yield* Schema.encodeUnknownEffect(
                  incrementRpcDef.errorSchema
                )(err)
                return yield* HttpServerResponse.json(encodedErr, { status: 400 })
              })
          )
          .with({ _tag: "Failure" }, ({ err }) =>
            HttpServerResponse.json({ error: String(err) }, { status: 500 })
          )
          .exhaustive()
      }).pipe(Effect.orDie)
  }
}

export { _makeAlbumCounterRpcHandler as makeAlbumCounterRpcHandler }

const _makeAlbumCounterRpcClient = (
  httpClient: HttpClient.HttpClient | { execute: any } | { fetch: any }
): Layer.Layer<AlbumCounterClient> & {
  readonly increment: (albumId: string) => Effect.Effect<number, AlbumQuotaExceededError>
  readonly getCount: (albumId: string) => Effect.Effect<number>
} => {
  const client: HttpClient.HttpClient =
    HttpClient.isHttpClient(httpClient) || "execute" in (httpClient as any)
      ? (httpClient as HttpClient.HttpClient)
      : _toHttpClient(httpClient as any)

  const increment = (albumId: string): Effect.Effect<number, AlbumQuotaExceededError> =>
    Effect.gen(function* () {
      const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const traceparent = formatTraceparent(maybeSpan)

      const encodedPayload = yield* Schema.encodeUnknownEffect(incrementRpcDef.payloadSchema)({
        albumId
      })
      let req = HttpClientRequest.post("http://localhost/rpc/IncrementAlbumCount").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "IncrementAlbumCount", ...encodedPayload })
      )
      if (traceparent) {
        req = HttpClientRequest.setHeader(req, "traceparent", traceparent)
      }

      const response = yield* client.execute(req)
      return yield* match(response.status)
        .with(200, () =>
          Effect.gen(function* () {
            const data = yield* HttpClientResponse.schemaBodyJson(
              Schema.Struct({ count: incrementRpcDef.successSchema })
            )(response)
            return data.count
          })
        )
        .otherwise(() =>
          Effect.gen(function* () {
            const err = yield* HttpClientResponse.schemaBodyJson(incrementRpcDef.errorSchema)(
              response
            )
            return yield* err
          })
        )
    }).pipe(
      Effect.catch((err: unknown) =>
        match(err)
          .with(P.instanceOf(AlbumQuotaExceededError), (e) => Effect.fail(e))
          .with(
            P.when(
              (e): e is AlbumQuotaExceededError =>
                e != null &&
                typeof e === "object" &&
                "_tag" in e &&
                e._tag === "AlbumQuotaExceededError"
            ),
            (e) => Effect.fail(e)
          )
          .otherwise((e) => Effect.die(e))
      )
    )

  const getCount = (albumId: string): Effect.Effect<number> =>
    Effect.gen(function* () {
      const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const traceparent = formatTraceparent(maybeSpan)

      const encodedPayload = yield* Schema.encodeUnknownEffect(getRpcDef.payloadSchema)({
        albumId
      })
      let req = HttpClientRequest.post("http://localhost/rpc/GetAlbumCount").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "GetAlbumCount", ...encodedPayload })
      )
      if (traceparent) {
        req = HttpClientRequest.setHeader(req, "traceparent", traceparent)
      }

      const response = yield* client.execute(req)
      const data = yield* HttpClientResponse.schemaBodyJson(
        Schema.Struct({ count: getRpcDef.successSchema })
      )(response)
      return data.count
    }).pipe(Effect.orDie)

  const service = AlbumCounterClient.of({ increment, getCount })
  const layer = Layer.succeed(AlbumCounterClient, service)
  return Object.assign(layer, service)
}

export const AlbumCounterClientMemoryLayer: Layer.Layer<AlbumCounterClient> =
  _makeAlbumCounterRpcClient(_makeAlbumCounterRpcHandler())

export {
  _makeAlbumCounterRpcClient as makeAlbumCounterRpcClient,
  _makeAlbumCounterStoreMemory as makeAlbumCounterStoreMemory,
  _makeAlbumCounterStoreDrizzle as makeAlbumCounterStoreDrizzle,
  _makeAlbumCounterDoLayer as makeAlbumCounterDoLayer,
  GetAlbumCount,
  IncrementAlbumCount
}
