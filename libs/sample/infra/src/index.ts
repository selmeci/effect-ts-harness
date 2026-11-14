import { Context, Effect, Layer, type Option, Ref, Scheduler, Schema, Tracer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import { match, P } from "ts-pattern"
import {
  type AlbumId,
  AlbumPhotoCount,
  AlbumQuotaExceededError,
  type CreatePhotoInput,
  GetAlbumCount,
  type GreetingMessage,
  IncrementAlbumCount,
  Photo,
  PhotoCounterRpc,
  type PhotoId,
  PhotoNotFoundError,
} from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"
import { decideAlbumQuota } from "@harness/sample-domain"

export type D1DatabaseBinding = D1Client.D1ClientConfig["db"]

const isSqlClient = (value: unknown): value is SqlClient =>
  (typeof value === "object" || typeof value === "function") &&
  value != null &&
  "withTransaction" in value

export const logToConsole = Effect.fn("Sample.logToConsole")(function* (message: GreetingMessage) {
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

    const insert = Effect.fn("PhotoRepo.insert")(function* (input: CreatePhotoInput) {
      const raw = {
        id: nextId++,
        name: input.name,
        albumId: input.albumId,
        createdAt: Math.floor(Date.now()),
      }
      const photo = yield* Schema.decodeEffect(Photo)(raw).pipe(Effect.orDie)
      yield* Ref.update(itemsRef, (items) => [...items, photo])
      return photo
    })

    const findById = Effect.fn("PhotoRepo.findById")(function* (id: PhotoId) {
      const items = yield* Ref.get(itemsRef)
      const found = items.find((p) => p.id === id)
      if (!found) {
        return yield* new PhotoNotFoundError({ id })
      }
      return found
    })

    const listAll: Effect.Effect<ReadonlyArray<Photo>> = Ref.get(itemsRef).pipe(
      Effect.withSpan("PhotoRepo.listAll"),
    )

    return PhotoRepo.of({ insert, findById, listAll })
  }),
)

// PhotoRepo Native Effect SQL Implementation (D1 / SQLite)
const _makePhotoRepoSql = (sql: SqlClient): PhotoRepo["Service"] => {
  const insert = Effect.fn("PhotoRepo.insert")(
    function* (input: CreatePhotoInput) {
      const createdAt = Math.floor(Date.now())
      const rows = yield* sql`
        INSERT INTO photos (name, album_id, created_at)
        VALUES (${input.name}, ${input.albumId}, ${createdAt})
        RETURNING id, name, album_id AS albumId, created_at AS createdAt
      `
      return yield* Schema.decodeUnknownEffect(Photo)(rows[0])
    },
    Effect.orDie,
  )

  const findById = Effect.fn("PhotoRepo.findById")(function* (id: PhotoId) {
    const rows = yield* sql`
      SELECT id, name, album_id AS albumId, created_at AS createdAt
      FROM photos
      WHERE id = ${id}
    `.pipe(Effect.orDie)
    if (rows.length === 0) {
      return yield* new PhotoNotFoundError({ id })
    }
    return yield* Schema.decodeUnknownEffect(Photo)(rows[0]).pipe(Effect.orDie)
  })

  const listAll: Effect.Effect<ReadonlyArray<Photo>> = Effect.gen(function* () {
    const rows = yield* sql`
      SELECT id, name, album_id AS albumId, created_at AS createdAt
      FROM photos
      ORDER BY id ASC
    `
    return yield* Schema.decodeUnknownEffect(Schema.Array(Photo))(rows)
  }).pipe(Effect.orDie, Effect.withSpan("PhotoRepo.listAll"))

  return PhotoRepo.of({ insert, findById, listAll })
}

export const PhotoRepoD1Layer: Layer.Layer<PhotoRepo, never, SqlClient> = Layer.effect(
  PhotoRepo,
  Effect.map(SqlClient, _makePhotoRepoSql),
)

const _makePhotoRepoD1Layer = (d1OrSql: D1DatabaseBinding | SqlClient): Layer.Layer<PhotoRepo> =>
  match(d1OrSql)
    .with(P.when(isSqlClient), (sql) => Layer.succeed(PhotoRepo, _makePhotoRepoSql(sql)))
    .otherwise((db) => PhotoRepoD1Layer.pipe(Layer.provide(D1Client.layer({ db })), Layer.orDie))

export {
  _makePhotoRepoSql as makePhotoRepoSql,
  _makePhotoRepoD1Layer as makePhotoRepoD1Layer,
}

// AlbumCounter Store Interface & Implementations
const MAX_PHOTOS_PER_ALBUM = 100

export interface AlbumCounterStore {
  readonly get: (albumId: AlbumId) => Effect.Effect<AlbumPhotoCount>
  readonly set: (albumId: AlbumId, count: AlbumPhotoCount) => Effect.Effect<void>
  readonly incrementWithQuota: (
    albumId: AlbumId,
  ) => Effect.Effect<AlbumPhotoCount, AlbumQuotaExceededError>
}

export class ActiveCounterStore extends Context.Service<ActiveCounterStore, AlbumCounterStore>()(
  "SampleInfra.ActiveCounterStore",
) {}

export const albumCounterMigrations: Readonly<
  Record<string, Effect.Effect<void, SqlError, SqlClient>>
> = {
  "1_init_album_counters": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql`
      CREATE TABLE IF NOT EXISTS album_counters (
        album_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      )
    `
  }),
}

export const initializeAlbumCounterTables = Effect.fn("SampleInfra.initAlbumCounterTables")(
  function* () {
    return yield* SqliteMigrator.run({
      loader: SqliteMigrator.fromRecord(albumCounterMigrations),
    })
  },
)

export const AlbumCounterMigratorLayer: Layer.Layer<
  never,
  SqliteMigrator.MigrationError | SqlError,
  SqlClient
> = SqliteMigrator.layer({
  loader: SqliteMigrator.fromRecord(albumCounterMigrations),
})

const _makeAlbumCounterStoreMemory = (initial: Record<string, number> = {}): AlbumCounterStore => {
  const map = new Map<string, number>(Object.entries(initial))
  return {
    get: (albumId: AlbumId) => Effect.sync(() => AlbumPhotoCount.make(map.get(albumId) ?? 0)),
    set: (albumId: AlbumId, count: AlbumPhotoCount) =>
      Effect.sync(() => {
        map.set(albumId, count)
      }),
    incrementWithQuota: (albumId: AlbumId) =>
      Effect.gen(function* () {
        const currentCount = AlbumPhotoCount.make(map.get(albumId) ?? 0)
        const nextCount = yield* decideAlbumQuota({ albumId, currentCount })
        map.set(albumId, nextCount)
        return nextCount
      }),
  }
}

export const AlbumCounterStoreMemoryLayer: Layer.Layer<ActiveCounterStore> = Layer.sync(
  ActiveCounterStore,
  () => _makeAlbumCounterStoreMemory(),
)

const _makeAlbumCounterStoreSql = (sql: SqlClient): AlbumCounterStore => ({
  get: (albumId: AlbumId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count FROM album_counters WHERE album_id = ${albumId}
      `
      const firstRow = rows[0]
      if (firstRow === undefined) {
        return AlbumPhotoCount.make(0)
      }
      return yield* match(Schema.decodeOption(AlbumPhotoCount)(firstRow.count))
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.die(
            new Error(`Invalid AlbumPhotoCount in album_counters: ${String(firstRow.count)}`),
          ),
        )
        .exhaustive()
    }).pipe(Effect.orDie),
  set: (albumId: AlbumId, count: AlbumPhotoCount) =>
    sql`
      INSERT INTO album_counters (album_id, count)
      VALUES (${albumId}, ${count})
      ON CONFLICT (album_id) DO UPDATE SET count = excluded.count
    `.pipe(Effect.asVoid, Effect.orDie),
  incrementWithQuota: (albumId: AlbumId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly count: number }>`
        INSERT INTO album_counters (album_id, count)
        VALUES (${albumId}, 1)
        ON CONFLICT(album_id) DO UPDATE SET count = album_counters.count + 1
        WHERE album_counters.count < ${MAX_PHOTOS_PER_ALBUM}
        RETURNING count
      `.pipe(Effect.orDie)
      const firstRow = rows[0]
      if (firstRow === undefined) {
        return yield* new AlbumQuotaExceededError({
          albumId,
          count: AlbumPhotoCount.make(MAX_PHOTOS_PER_ALBUM),
        })
      }
      return yield* match(Schema.decodeOption(AlbumPhotoCount)(firstRow.count))
        .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
        .with({ _tag: "None" }, () =>
          Effect.die(
            new Error(`Invalid AlbumPhotoCount in album_counters: ${String(firstRow.count)}`),
          ),
        )
        .exhaustive()
    }),
})

export const AlbumCounterDoLayer: Layer.Layer<ActiveCounterStore, never, SqlClient> = Layer.effect(
  ActiveCounterStore,
  Effect.map(SqlClient, _makeAlbumCounterStoreSql),
)

const _makeAlbumCounterDoLayer = (
  d1OrSql: D1DatabaseBinding | SqlClient,
): Layer.Layer<ActiveCounterStore> =>
  match(d1OrSql)
    .with(P.when(isSqlClient), (sql) =>
      Layer.succeed(ActiveCounterStore, _makeAlbumCounterStoreSql(sql)),
    )
    .otherwise((db) => AlbumCounterDoLayer.pipe(Layer.provide(D1Client.layer({ db })), Layer.orDie))

const RpcActionSchema = Schema.Struct({
  action: Schema.optional(Schema.Literals(["GetAlbumCount", "IncrementAlbumCount"])),
})

const formatTraceparent = (maybeSpan: Option.Option<Tracer.AnySpan>): string | undefined =>
  match(maybeSpan)
    .with({ _tag: "Some" }, ({ value }) => `00-${value.traceId}-${value.spanId}-01`)
    .with({ _tag: "None" }, () => undefined)
    .exhaustive()

export const handleAlbumCounterRpc = Effect.fn("SampleInfra.handleAlbumCounterRpc")(function* (
  rawInput: unknown,
) {
  const parsedAction = yield* Schema.decodeUnknownEffect(RpcActionSchema)(rawInput)
  const action = parsedAction.action ?? "IncrementAlbumCount"
  if (!PhotoCounterRpc.requests.has(action)) {
    return yield* Effect.die(new Error(`Unknown PhotoCounterRpc action: ${action}`))
  }

  const maybeStore = yield* Effect.serviceOption(ActiveCounterStore)
  const store = match(maybeStore)
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => _makeAlbumCounterStoreMemory())
    .exhaustive()

  // Synchronous DO transaction discipline: decode outside, then run store + decide under MixedScheduler("sync")
  return yield* match(action)
    .with("GetAlbumCount", () =>
      Effect.gen(function* () {
        const payload = yield* Schema.decodeUnknownEffect(GetAlbumCount.payloadSchema)(rawInput)
        return yield* store
          .get(payload.albumId)
          .pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")))
      }),
    )
    .with("IncrementAlbumCount", () =>
      Effect.gen(function* () {
        const payload = yield* Schema.decodeUnknownEffect(IncrementAlbumCount.payloadSchema)(
          rawInput,
        )
        return yield* Effect.gen(function* () {
          const currentCount = yield* store.get(payload.albumId)
          yield* decideAlbumQuota({
            albumId: payload.albumId,
            currentCount,
          })
          return yield* store.incrementWithQuota(payload.albumId)
        }).pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")))
      }),
    )
    .exhaustive()
})

export interface ServerRequestFetcher {
  readonly fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Error, never>
}

const _toHttpClient = (fetcher: ServerRequestFetcher): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const serverReq = HttpServerRequest.fromClientRequest(request)
      const res = yield* fetcher.fetch(serverReq)
      return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(res))
    }).pipe(Effect.orDie),
  )

export { _toHttpClient as toHttpClient }

const isServerRequest = (req: unknown): req is HttpServerRequest.HttpServerRequest =>
  req != null && typeof req === "object" && HttpServerRequest.TypeId in req

const isAlbumCounterStore = (value: unknown): value is AlbumCounterStore =>
  value != null && typeof value === "object" && "get" in value && "set" in value

const _makeAlbumCounterRpcHandler = (
  storeOrSql?: AlbumCounterStore | SqlClient,
): {
  readonly fetch: (
    request: HttpServerRequest.HttpServerRequest | Request,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, never>
} => {
  const localStore: AlbumCounterStore = match(storeOrSql)
    .with(P.when(isAlbumCounterStore), (s) => s)
    .with(P.when(isSqlClient), (sql) => _makeAlbumCounterStoreSql(sql))
    .otherwise(() => _makeAlbumCounterStoreMemory())

  return {
    fetch: (
      request: HttpServerRequest.HttpServerRequest | Request,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
      Effect.gen(function* () {
        let traceparentHeader: string | undefined
        let rawBody: unknown

        if (isServerRequest(request)) {
          traceparentHeader = request.headers["traceparent"]
          rawBody = yield* Effect.orDie(request.json)
        } else {
          traceparentHeader = request.headers.get("traceparent") ?? undefined
          rawBody = yield* Effect.orDie(Effect.promise(() => request.json()))
        }

        let externalSpan: Tracer.ExternalSpan | undefined
        if (typeof traceparentHeader === "string") {
          const parsedTrace = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i.exec(
            traceparentHeader.trim(),
          )
          if (parsedTrace && parsedTrace[1] && parsedTrace[2]) {
            externalSpan = Tracer.externalSpan({
              traceId: parsedTrace[1],
              spanId: parsedTrace[2],
              sampled: true,
            })
          }
        }

        let handler = handleAlbumCounterRpc(rawBody).pipe(
          Effect.provideService(ActiveCounterStore, localStore),
        )
        if (externalSpan) {
          handler = Effect.withParentSpan(handler, externalSpan)
        }

        const res = yield* handler.pipe(
          Effect.map((count) => ({ _tag: "Success" as const, count })),
          Effect.catch((err: unknown) => Effect.succeed({ _tag: "Failure" as const, err })),
        )

        return yield* match(res)
          .with({ _tag: "Success" }, ({ count }) =>
            Effect.gen(function* () {
              const encodedCount = yield* Schema.encodeUnknownEffect(
                IncrementAlbumCount.successSchema,
              )(count)
              return yield* HttpServerResponse.json({ count: encodedCount })
            }),
          )
          .with(
            {
              _tag: "Failure",
              err: P.when(
                (failure): failure is AlbumQuotaExceededError =>
                  failure != null &&
                  typeof failure === "object" &&
                  "_tag" in failure &&
                  failure._tag === "AlbumQuotaExceededError",
              ),
            },
            ({ err }) =>
              Effect.gen(function* () {
                const encodedErr = yield* Schema.encodeUnknownEffect(
                  IncrementAlbumCount.errorSchema,
                )(err)
                return yield* HttpServerResponse.json(encodedErr, { status: 400 })
              }),
          )
          .with({ _tag: "Failure" }, ({ err }) =>
            HttpServerResponse.json({ error: String(err) }, { status: 500 }),
          )
          .exhaustive()
      }).pipe(Effect.orDie),
  }
}

export { _makeAlbumCounterRpcHandler as makeAlbumCounterRpcHandler }

const _makeAlbumCounterRpcClient = (
  httpClient: HttpClient.HttpClient | ServerRequestFetcher,
): Layer.Layer<AlbumCounterClient> & {
  readonly increment: (albumId: AlbumId) => Effect.Effect<AlbumPhotoCount, AlbumQuotaExceededError>
  readonly getCount: (albumId: AlbumId) => Effect.Effect<AlbumPhotoCount>
} => {
  const client: HttpClient.HttpClient = HttpClient.isHttpClient(httpClient)
    ? httpClient
    : _toHttpClient(httpClient)

  const increment = (albumId: AlbumId): Effect.Effect<AlbumPhotoCount, AlbumQuotaExceededError> =>
    Effect.gen(function* () {
      const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const traceparent = formatTraceparent(maybeSpan)

      const encodedPayload = yield* Schema.encodeUnknownEffect(IncrementAlbumCount.payloadSchema)({
        albumId,
      })
      let req = HttpClientRequest.post("http://localhost/rpc/IncrementAlbumCount").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "IncrementAlbumCount", ...encodedPayload }),
      )
      if (traceparent) {
        req = HttpClientRequest.setHeader(req, "traceparent", traceparent)
      }

      const response = yield* client.execute(req)
      return yield* match(response.status)
        .with(200, () =>
          Effect.gen(function* () {
            const data = yield* HttpClientResponse.schemaBodyJson(
              Schema.Struct({ count: IncrementAlbumCount.successSchema }),
            )(response)
            return data.count
          }),
        )
        .otherwise(() =>
          Effect.gen(function* () {
            const err = yield* HttpClientResponse.schemaBodyJson(IncrementAlbumCount.errorSchema)(
              response,
            )
            return yield* err
          }),
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
                e._tag === "AlbumQuotaExceededError",
            ),
            (e) => Effect.fail(e),
          )
          .otherwise((e) => Effect.die(e)),
      ),
    )

  const getCount = (albumId: AlbumId): Effect.Effect<AlbumPhotoCount> =>
    Effect.gen(function* () {
      const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const traceparent = formatTraceparent(maybeSpan)

      const encodedPayload = yield* Schema.encodeUnknownEffect(GetAlbumCount.payloadSchema)({
        albumId,
      })
      let req = HttpClientRequest.post("http://localhost/rpc/GetAlbumCount").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "GetAlbumCount", ...encodedPayload }),
      )
      if (traceparent) {
        req = HttpClientRequest.setHeader(req, "traceparent", traceparent)
      }

      const response = yield* client.execute(req)
      const data = yield* HttpClientResponse.schemaBodyJson(
        Schema.Struct({ count: GetAlbumCount.successSchema }),
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
  _makeAlbumCounterStoreSql as makeAlbumCounterStoreSql,
  _makeAlbumCounterDoLayer as makeAlbumCounterDoLayer,
  GetAlbumCount,
  IncrementAlbumCount,
}
