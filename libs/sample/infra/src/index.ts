import { Clock, Effect, Layer, type Option, Ref, Scheduler, Schema, Tracer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator"
import { match, P } from "ts-pattern"
import {
  AlbumCounterProtocolError,
  AlbumCounterStorageError,
  type AlbumId,
  AlbumPhotoCount,
  AlbumQuotaExceededError,
  type CreatePhotoInput,
  DecrementAlbumCount,
  GetAlbumCount,
  type GreetingMessage,
  HttpStatusCode,
  IncrementAlbumCount,
  MAX_PHOTOS_PER_ALBUM,
  Photo,
  PhotoCounterRpc,
  type PhotoId,
  PhotoNotFoundError,
  PhotoStorageError,
  ProtocolErrorMessage,
  StorageErrorMessage,
  StorageOperationName,
} from "@harness/sample-contract"
import {
  ActiveCounterStore,
  AlbumCounterClient,
  type AlbumCounterStore,
  AlbumCounterStoreTypeId,
  PhotoRepo,
} from "@harness/sample-service"
import { decideAlbumQuota } from "@harness/sample-domain"

export type D1DatabaseBinding = D1Client.D1ClientConfig["db"]
export type SqlStorageBinding = NonNullable<SqliteClient.SqliteClientConfig["db"]>

const SQL_CLIENT_TYPE_ID = "~effect/sql/SqlClient"

const isSqlClient = (value: unknown): value is SqlClient =>
  (typeof value === "object" || typeof value === "function") &&
  value != null &&
  SQL_CLIENT_TYPE_ID in value

const isD1Database = (value: unknown): value is D1DatabaseBinding =>
  (typeof value === "object" || typeof value === "function") &&
  value != null &&
  typeof (value as { readonly prepare?: unknown }).prepare === "function"

const isAlbumCounterStore = (value: unknown): value is AlbumCounterStore =>
  value != null && typeof value === "object" && AlbumCounterStoreTypeId in value

const toPhotoStorageError = (operation: string, err: unknown): PhotoStorageError =>
  new PhotoStorageError({
    operation: StorageOperationName.make(operation),
    message: StorageErrorMessage.make(err instanceof Error ? err.message : String(err)),
  })

const toCounterStorageError = (operation: string, err: unknown): AlbumCounterStorageError =>
  new AlbumCounterStorageError({
    operation: StorageOperationName.make(operation),
    message: StorageErrorMessage.make(err instanceof Error ? err.message : String(err)),
  })

const toProtocolError = (status: number, err: unknown): AlbumCounterProtocolError =>
  new AlbumCounterProtocolError({
    status: HttpStatusCode.make(status),
    message: ProtocolErrorMessage.make(err instanceof Error ? err.message : String(err)),
  })

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
      const nowMillis = yield* Clock.currentTimeMillis
      const raw = {
        id: nextId++,
        name: input.name,
        albumId: input.albumId,
        createdAt: Math.floor(nowMillis),
      }
      const photo = yield* Schema.decodeEffect(Photo)(raw).pipe(
        Effect.mapError((err) => toPhotoStorageError("PhotoRepo.insert", err)),
      )
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

    const listAll: Effect.Effect<ReadonlyArray<Photo>, PhotoStorageError> = Ref.get(itemsRef).pipe(
      Effect.withSpan("PhotoRepo.listAll"),
    )

    return PhotoRepo.of({ insert, findById, listAll })
  }),
)

// PhotoRepo Native Effect SQL Implementation (D1 / SQLite)
const _makePhotoRepoSql = (sql: SqlClient): PhotoRepo["Service"] => {
  const insert = Effect.fn("PhotoRepo.insert")(function* (input: CreatePhotoInput) {
    const nowMillis = yield* Clock.currentTimeMillis
    const createdAt = Math.floor(nowMillis)
    const rows = yield* sql`
      INSERT INTO photos (name, album_id, created_at)
      VALUES (${input.name}, ${input.albumId}, ${createdAt})
      RETURNING id, name, album_id AS albumId, created_at AS createdAt
    `.pipe(Effect.mapError((err) => toPhotoStorageError("PhotoRepo.insert", err)))
    const firstRow = rows[0]
    if (firstRow === undefined) {
      return yield* toPhotoStorageError(
        "PhotoRepo.insert",
        "INSERT INTO photos RETURNING did not return a row",
      )
    }
    return yield* Schema.decodeUnknownEffect(Photo)(firstRow).pipe(
      Effect.mapError((err) => toPhotoStorageError("PhotoRepo.insert", err)),
    )
  })

  const findById = Effect.fn("PhotoRepo.findById")(function* (id: PhotoId) {
    const rows = yield* sql`
      SELECT id, name, album_id AS albumId, created_at AS createdAt
      FROM photos
      WHERE id = ${id}
    `.pipe(Effect.mapError((err) => toPhotoStorageError("PhotoRepo.findById", err)))
    const firstRow = rows[0]
    if (firstRow === undefined) {
      return yield* new PhotoNotFoundError({ id })
    }
    return yield* Schema.decodeUnknownEffect(Photo)(firstRow).pipe(
      Effect.mapError((err) => toPhotoStorageError("PhotoRepo.findById", err)),
    )
  })

  const listAll: Effect.Effect<ReadonlyArray<Photo>, PhotoStorageError> = Effect.gen(function* () {
    const rows = yield* sql`
      SELECT id, name, album_id AS albumId, created_at AS createdAt
      FROM photos
      ORDER BY id ASC
    `
    return yield* Schema.decodeUnknownEffect(Schema.Array(Photo))(rows)
  }).pipe(
    Effect.mapError((err) => toPhotoStorageError("PhotoRepo.listAll", err)),
    Effect.withSpan("PhotoRepo.listAll"),
  )

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

// PhotoCounterDO stores per-album counters in DO SQLite via SqliteMigrator,
// while D1 stores `photos` + fallback `album_counters` via `migrations/0001_photos_and_counters.sql`.
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
    [AlbumCounterStoreTypeId]: AlbumCounterStoreTypeId,
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
    decrement: (albumId: AlbumId) =>
      Effect.sync(() => {
        const current = map.get(albumId) ?? 0
        const next = Math.max(0, current - 1)
        map.set(albumId, next)
        return AlbumPhotoCount.make(next)
      }),
  }
}

export const AlbumCounterStoreMemoryLayer: Layer.Layer<ActiveCounterStore> = Layer.sync(
  ActiveCounterStore,
  () => _makeAlbumCounterStoreMemory(),
)

const decodeAlbumPhotoCount = (
  operation: string,
  rawCount: unknown,
): Effect.Effect<AlbumPhotoCount, AlbumCounterStorageError> =>
  match(Schema.decodeUnknownOption(AlbumPhotoCount)(rawCount))
    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        toCounterStorageError(
          operation,
          `Invalid AlbumPhotoCount in album_counters: ${String(rawCount)}`,
        ),
      ),
    )
    .exhaustive()

const _makeAlbumCounterStoreSql = (sql: SqlClient): AlbumCounterStore => ({
  [AlbumCounterStoreTypeId]: AlbumCounterStoreTypeId,
  get: (albumId: AlbumId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count FROM album_counters WHERE album_id = ${albumId}
      `.pipe(Effect.mapError((err) => toCounterStorageError("AlbumCounterStore.get", err)))
      const firstRow = rows[0]
      if (firstRow === undefined) {
        return AlbumPhotoCount.make(0)
      }
      return yield* decodeAlbumPhotoCount("AlbumCounterStore.get", firstRow.count)
    }),
  set: (albumId: AlbumId, count: AlbumPhotoCount) =>
    sql`
      INSERT INTO album_counters (album_id, count)
      VALUES (${albumId}, ${count})
      ON CONFLICT (album_id) DO UPDATE SET count = excluded.count
    `.pipe(
      Effect.asVoid,
      Effect.mapError((err) => toCounterStorageError("AlbumCounterStore.set", err)),
    ),
  incrementWithQuota: (albumId: AlbumId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly count: number }>`
        INSERT INTO album_counters (album_id, count)
        VALUES (${albumId}, 1)
        ON CONFLICT(album_id) DO UPDATE SET count = album_counters.count + 1
        WHERE album_counters.count < ${MAX_PHOTOS_PER_ALBUM}
        RETURNING count
      `.pipe(
        Effect.mapError((err) => toCounterStorageError("AlbumCounterStore.incrementWithQuota", err)),
      )
      const firstRow = rows[0]
      if (firstRow === undefined) {
        const existingRows = yield* sql<{ readonly count: number }>`
          SELECT count FROM album_counters WHERE album_id = ${albumId}
        `.pipe(
          Effect.mapError((err) =>
            toCounterStorageError("AlbumCounterStore.incrementWithQuota", err),
          ),
        )
        const existingRow = existingRows[0]
        if (existingRow === undefined) {
          return yield* toCounterStorageError(
            "AlbumCounterStore.incrementWithQuota",
            "Conditional upsert returned no rows and no album_counters row exists",
          )
        }
        const storedCount = yield* decodeAlbumPhotoCount(
          "AlbumCounterStore.incrementWithQuota",
          existingRow.count,
        )
        if (storedCount >= MAX_PHOTOS_PER_ALBUM) {
          return yield* new AlbumQuotaExceededError({
            albumId,
            count: storedCount,
          })
        }
        return yield* toCounterStorageError(
          "AlbumCounterStore.incrementWithQuota",
          `Conditional upsert returned no rows despite stored count ${storedCount} < ${MAX_PHOTOS_PER_ALBUM}`,
        )
      }
      return yield* decodeAlbumPhotoCount("AlbumCounterStore.incrementWithQuota", firstRow.count)
    }),
  decrement: (albumId: AlbumId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly count: number }>`
        INSERT INTO album_counters (album_id, count)
        VALUES (${albumId}, 0)
        ON CONFLICT(album_id) DO UPDATE SET count = MAX(0, album_counters.count - 1)
        RETURNING count
      `.pipe(Effect.mapError((err) => toCounterStorageError("AlbumCounterStore.decrement", err)))
      const firstRow = rows[0]
      if (firstRow === undefined) {
        return yield* toCounterStorageError(
          "AlbumCounterStore.decrement",
          "Decrement upsert RETURNING did not return a row",
        )
      }
      return yield* decodeAlbumPhotoCount("AlbumCounterStore.decrement", firstRow.count)
    }),
})

export const AlbumCounterDoLayer: Layer.Layer<ActiveCounterStore, never, SqlClient> = Layer.effect(
  ActiveCounterStore,
  Effect.map(SqlClient, _makeAlbumCounterStoreSql),
)

const _makeAlbumCounterDoLayer = (
  binding: D1DatabaseBinding | SqlStorageBinding | SqlClient,
): Layer.Layer<ActiveCounterStore> =>
  match(binding)
    .with(P.when(isSqlClient), (sql) =>
      Layer.succeed(ActiveCounterStore, _makeAlbumCounterStoreSql(sql)),
    )
    .with(P.when(isD1Database), (db) =>
      AlbumCounterDoLayer.pipe(Layer.provide(D1Client.layer({ db })), Layer.orDie),
    )
    .otherwise((sqlStorage) =>
      AlbumCounterDoLayer.pipe(Layer.provide(SqliteClient.layer({ db: sqlStorage })), Layer.orDie),
    )

const RpcActionSchema = Schema.Struct({
  action: Schema.Literals(["GetAlbumCount", "IncrementAlbumCount", "DecrementAlbumCount"]),
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
  const action = parsedAction.action
  if (!PhotoCounterRpc.requests.has(action)) {
    return yield* toProtocolError(400, `Unknown PhotoCounterRpc action: ${action}`)
  }

  const maybeStore = yield* Effect.serviceOption(ActiveCounterStore)
  const store = yield* match(maybeStore)
    .with({ _tag: "Some" }, ({ value }) => Effect.succeed(value))
    .with({ _tag: "None" }, () =>
      Effect.fail(
        toCounterStorageError(
          "handleAlbumCounterRpc",
          "ActiveCounterStore service is not provided",
        ),
      ),
    )
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
    .with("DecrementAlbumCount", () =>
      Effect.gen(function* () {
        const payload = yield* Schema.decodeUnknownEffect(DecrementAlbumCount.payloadSchema)(
          rawInput,
        )
        return yield* store
          .decrement(payload.albumId)
          .pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")))
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

const parseRequestJson = (
  request: HttpServerRequest.HttpServerRequest | Request,
): Effect.Effect<Option.Option<unknown>, never, never> => {
  if (isServerRequest(request)) {
    return request.json.pipe(Effect.option)
  }
  return Effect.tryPromise({
    try: () => request.json(),
    catch: () => toProtocolError(400, "Invalid JSON"),
  }).pipe(Effect.option)
}

const extractTraceparentHeader = (
  request: HttpServerRequest.HttpServerRequest | Request,
): string | undefined => {
  if (isServerRequest(request)) {
    return request.headers["traceparent"]
  }
  return request.headers.get("traceparent") ?? undefined
}

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
        const maybeBody = yield* parseRequestJson(request)
        return yield* match(maybeBody)
          .with({ _tag: "None" }, () =>
            HttpServerResponse.json(
              { error: "invalid_json", message: "Malformed JSON request body" },
              { status: 400 },
            ),
          )
          .with({ _tag: "Some" }, ({ value: rawBody }) =>
            Effect.gen(function* () {
              const traceparentHeader = extractTraceparentHeader(request)
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
                Effect.flatMap((count) =>
                  Schema.encodeUnknownEffect(IncrementAlbumCount.successSchema)(count).pipe(
                    Effect.mapError((err) =>
                      toCounterStorageError("AlbumCounterRpc.encodeResponse", err),
                    ),
                  ),
                ),
                Effect.provideService(ActiveCounterStore, localStore),
              )
              if (externalSpan) {
                handler = Effect.withParentSpan(handler, externalSpan)
              }

              const res = yield* handler.pipe(
                Effect.map((encodedCount) => ({ _tag: "Success" as const, encodedCount })),
                Effect.catch((err: unknown) => Effect.succeed({ _tag: "Failure" as const, err })),
              )

              return yield* match(res)
                .with({ _tag: "Success" }, ({ encodedCount }) =>
                  HttpServerResponse.json({ count: encodedCount }),
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
                      return yield* HttpServerResponse.json(encodedErr, { status: 429 })
                    }),
                )
                .with(
                  {
                    _tag: "Failure",
                    err: P.when(Schema.isSchemaError),
                  },
                  () =>
                    HttpServerResponse.json(
                      { error: "invalid_request", message: "Invalid RPC request payload" },
                      { status: 400 },
                    ),
                )
                .with(
                  {
                    _tag: "Failure",
                    err: P.instanceOf(AlbumCounterProtocolError),
                  },
                  () =>
                    HttpServerResponse.json(
                      { error: "invalid_request", message: "Invalid RPC request" },
                      { status: 400 },
                    ),
                )
                .with(
                  {
                    _tag: "Failure",
                    err: P.instanceOf(AlbumCounterStorageError),
                  },
                  () =>
                    HttpServerResponse.json(
                      { error: "storage_failure", message: "Counter storage operation failed" },
                      { status: 500 },
                    ),
                )
                .with({ _tag: "Failure" }, () =>
                  HttpServerResponse.json(
                    { error: "storage_failure", message: "Internal counter service error" },
                    { status: 500 },
                  ),
                )
                .exhaustive()
            }),
          )
          .exhaustive()
      }).pipe(Effect.orDie),
  }
}

export { _makeAlbumCounterRpcHandler as makeAlbumCounterRpcHandler }

const _makeAlbumCounterRpcClient = (
  httpClient: HttpClient.HttpClient | ServerRequestFetcher,
): Layer.Layer<AlbumCounterClient> & AlbumCounterClient["Service"] => {
  const client: HttpClient.HttpClient = HttpClient.isHttpClient(httpClient)
    ? httpClient
    : _toHttpClient(httpClient)

  const sendAction = (
    action: "IncrementAlbumCount" | "GetAlbumCount" | "DecrementAlbumCount",
    albumId: AlbumId,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, AlbumCounterProtocolError> =>
    Effect.gen(function* () {
      const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)
      const traceparent = formatTraceparent(maybeSpan)
      const encodedPayload = yield* Schema.encodeUnknownEffect(GetAlbumCount.payloadSchema)({
        albumId,
      }).pipe(Effect.mapError((err) => toProtocolError(400, err)))
      let req = HttpClientRequest.post(`http://localhost/rpc/${action}`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ action, ...encodedPayload }),
      )
      if (traceparent) {
        req = HttpClientRequest.setHeader(req, "traceparent", traceparent)
      }
      return yield* client.execute(req).pipe(Effect.mapError((err) => toProtocolError(502, err)))
    })

  const decodeSuccessCount = (
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<AlbumPhotoCount, AlbumCounterProtocolError> =>
    HttpClientResponse.schemaBodyJson(Schema.Struct({ count: IncrementAlbumCount.successSchema }))(
      response,
    ).pipe(
      Effect.map((data) => data.count),
      Effect.mapError((err) => toProtocolError(response.status, err)),
    )

  const readErrorProtocol = (
    response: HttpClientResponse.HttpClientResponse,
    action: string,
  ): Effect.Effect<never, AlbumCounterProtocolError> =>
    response.text.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((bodyText) =>
        Effect.fail(
          toProtocolError(
            response.status,
            `${action} failed with HTTP ${response.status}${bodyText.length > 0 ? `: ${bodyText}` : ""}`,
          ),
        ),
      ),
    )

  const increment = (
    albumId: AlbumId,
  ): Effect.Effect<
    AlbumPhotoCount,
    AlbumQuotaExceededError | AlbumCounterStorageError | AlbumCounterProtocolError
  > =>
    Effect.gen(function* () {
      const response = yield* sendAction("IncrementAlbumCount", albumId)
      return yield* match(response.status)
        .with(200, () => decodeSuccessCount(response))
        .with(429, () =>
          HttpClientResponse.schemaBodyJson(IncrementAlbumCount.errorSchema)(response).pipe(
            Effect.mapError((err) => toProtocolError(429, err)),
            Effect.flatMap((quotaErr) => Effect.fail(quotaErr)),
          ),
        )
        .otherwise(() => readErrorProtocol(response, "IncrementAlbumCount"))
    })

  const decrement = (
    albumId: AlbumId,
  ): Effect.Effect<AlbumPhotoCount, AlbumCounterStorageError | AlbumCounterProtocolError> =>
    Effect.gen(function* () {
      const response = yield* sendAction("DecrementAlbumCount", albumId)
      return yield* match(response.status)
        .with(200, () => decodeSuccessCount(response))
        .otherwise(() => readErrorProtocol(response, "DecrementAlbumCount"))
    })

  const getCount = (
    albumId: AlbumId,
  ): Effect.Effect<AlbumPhotoCount, AlbumCounterStorageError | AlbumCounterProtocolError> =>
    Effect.gen(function* () {
      const response = yield* sendAction("GetAlbumCount", albumId)
      return yield* match(response.status)
        .with(200, () => decodeSuccessCount(response))
        .otherwise(() => readErrorProtocol(response, "GetAlbumCount"))
    })

  const service = AlbumCounterClient.of({ increment, decrement, getCount })
  const layer = Layer.succeed(AlbumCounterClient, service)
  return Object.assign(layer, service)
}

export const AlbumCounterClientMemoryLayer: Layer.Layer<AlbumCounterClient> =
  _makeAlbumCounterRpcClient(_makeAlbumCounterRpcHandler())

export {
  ActiveCounterStore,
  type AlbumCounterStore,
  _makeAlbumCounterRpcClient as makeAlbumCounterRpcClient,
  _makeAlbumCounterStoreMemory as makeAlbumCounterStoreMemory,
  _makeAlbumCounterStoreSql as makeAlbumCounterStoreSql,
  _makeAlbumCounterDoLayer as makeAlbumCounterDoLayer,
  DecrementAlbumCount,
  GetAlbumCount,
  IncrementAlbumCount,
}
