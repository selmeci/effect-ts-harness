import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Result, type Scope } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClientModule from "effect/sql/SqlClient"
import { SqlClient } from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import * as Statement from "effect/sql/Statement"
import * as nodeFs from "node:fs"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as D1Client from "@effect/sql-d1/D1Client"
import { SqlClientMemoryLayer } from "@harness/es-infra/memory"
import {
  BINDING_D1_OBJECT,
  D1_OBJECT_CLASS_NAME,
  SERVICE_D1,
  SERVICE_D1_STORAGE,
} from "@alchemy.run/cloudflare-runtime/core/bindings/d1/D1Options"
import {
  type InternalWorkerModule,
  loadInternalWorker,
} from "@alchemy.run/cloudflare-runtime/core/internal/internal-worker"
import { connect } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/connect"
import { BINDING_PLATFORM_PROXY_TOKEN } from "@alchemy.run/cloudflare-runtime/core/platform-proxy/PlatformProxyProtocol"
import type * as WorkerdConfig from "@alchemy.run/cloudflare-runtime/core/workerd/Config"
import { Workerd, WorkerdLive } from "@alchemy.run/cloudflare-runtime/core/workerd/Workerd"
import { buildWorkspaceFnIndex, runWithTestTracer } from "@harness/ingest"
import type { SyncHostIo } from "@harness/service/host-io"
import {
  AlbumId,
  AlbumPhotoCount,
  GreetingMessage,
  PhotoId,
  PhotoName,
} from "@harness/sample-contract"
import { uploadPhoto } from "@harness/sample-domain"
import { PhotoRepo } from "@harness/sample-service"
import {
  ActiveCounterStore,
  albumCounterMigrations,
  handleAlbumCounterRpc,
  initializeAlbumCounterTables,
  logToConsole,
  makeAlbumCounterDoLayer,
  makeAlbumCounterRpcClient,
  makeAlbumCounterRpcHandler,
  makeAlbumCounterStoreSql,
  makePhotoRepoD1Layer,
  PhotoRepoMemoryLayer,
  toHttpClient,
} from "../src/index.js"

const resolveRepoRoot = (startDir: string): string => {
  let cur = startDir
  while (cur !== "/" && cur !== "") {
    if (existsSync(join(cur, "pnpm-workspace.yaml"))) {
      return cur
    }
    cur = join(cur, "..")
  }
  return startDir
}

type D1Database = Parameters<typeof D1Client.layer>[0]["db"]
const formatWorkerModules = (bundle: InternalWorkerModule): Array<WorkerdConfig.Worker_Module> => {
  const mainContent = bundle.modules[bundle.main] ?? ""
  return [
    { name: bundle.main, esModule: mainContent },
    ...Object.entries(bundle.modules)
      .filter(([name]) => name !== bundle.main)
      .map(([name, esModule]) => ({ name, esModule })),
  ]
}

const createWorkerdD1Database = (options?: {
  readonly skipSchema?: boolean
}): Effect.Effect<D1Database, never, Scope.Scope> =>
  Effect.gen(function* () {
    const tmpDir = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "harness-sample-d1-"))),
      (dir) =>
        Effect.sync(() => {
          rmSync(dir, { recursive: true, force: true })
        }),
    )
    const [d1Worker, proxyWorker] = yield* Effect.promise(() =>
      Promise.all([
        loadInternalWorker("#cloudflare-runtime-core-worker/bindings/d1/D1.worker"),
        loadInternalWorker("#cloudflare-runtime-core-worker/platform-proxy/PlatformProxy.worker"),
      ]),
    )
    const workerd = yield* Workerd
    const token = crypto.randomUUID()
    const ports = yield* workerd.serve({
      sockets: [
        {
          name: "entry",
          address: "127.0.0.1:0",
          http: {},
          service: { name: "proxy" },
        },
      ],
      services: [
        { name: SERVICE_D1_STORAGE, disk: { path: tmpDir, writable: true } },
        {
          name: SERVICE_D1,
          worker: {
            compatibilityDate: workerd.compatibilityDate,
            modules: formatWorkerModules(d1Worker),
            durableObjectNamespaces: [
              {
                className: D1_OBJECT_CLASS_NAME,
                enableSql: true,
                uniqueKey: `cloudflare-runtime-${D1_OBJECT_CLASS_NAME}`,
                preventEviction: true,
              },
            ],
            durableObjectStorage: { localDisk: SERVICE_D1_STORAGE },
            bindings: [
              {
                name: BINDING_D1_OBJECT,
                durableObjectNamespace: { className: D1_OBJECT_CLASS_NAME },
              },
            ],
          },
        },
        {
          name: "proxy",
          worker: {
            compatibilityDate: workerd.compatibilityDate,
            compatibilityFlags: ["nodejs_compat"],
            modules: formatWorkerModules(proxyWorker),
            bindings: [
              { name: BINDING_PLATFORM_PROXY_TOKEN, text: token },
              {
                name: "DB",
                wrapped: {
                  moduleName: "cloudflare-internal:d1-api",
                  innerBindings: [
                    {
                      name: "fetcher",
                      service: {
                        name: SERVICE_D1,
                        props: { json: JSON.stringify({ databaseId: "sample-db" }) },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    })
    const entryPort = ports.entry
    const connected = yield* Effect.promise(() =>
      connect<{ readonly DB: D1Database }>({
        url: `http://127.0.0.1:${String(entryPort)}`,
        token,
      }),
    )
    const d1 = connected.env.DB
    if (!options?.skipSchema) {
      const repoRoot = resolveRepoRoot(process.cwd())
      const migrationSql = nodeFs.readFileSync(
        join(repoRoot, "libs/sample/infra/migrations/0001_photos_and_counters.sql"),
        "utf8",
      )
      const statements = migrationSql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      yield* Effect.promise(async () => {
        for (const stmt of statements) {
          await d1.prepare(stmt).run()
        }
      })
    }
    return d1
  }).pipe(Effect.provide(WorkerdLive), Effect.orDie)

describe("sample-infra", () => {
  it.effect("runs logToConsole without failing", () =>
    logToConsole(GreetingMessage.make("harness")),
  )

  // Test 1: PhotoRepo backed by Native Effect SQL / D1 queries
  describe("PhotoRepo", () => {
    it.effect("inserts, fetches by ID, lists all photos, and decodes into Photo schema", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const d1 = yield* createWorkerdD1Database()
          const repoLayer = makePhotoRepoD1Layer(d1)

          const program = Effect.gen(function* () {
            const repo = yield* PhotoRepo

            // Insert photo
            const created = yield* repo.insert({
              name: PhotoName.make("Vacation.jpg"),
              albumId: AlbumId.make("album-1"),
            })

            expect(created.id).toBe(1)
            expect(created.name).toBe("Vacation.jpg")
            expect(created.albumId).toBe("album-1")
            expect(typeof created.createdAt).toBe("number")

            // Find by ID
            const fetched = yield* repo.findById(created.id)
            expect(fetched).toEqual(created)

            // Find missing by ID should fail with PhotoNotFoundError
            const missingError = yield* Effect.flip(repo.findById(PhotoId.make(999)))
            expect(missingError).toMatchObject({ _tag: "PhotoNotFoundError", id: 999 })

            // Insert second photo
            yield* repo.insert({
              name: PhotoName.make("Sunset.jpg"),
              albumId: AlbumId.make("album-1"),
            })

            // List all photos
            const all = yield* repo.listAll
            expect(all).toHaveLength(2)
            expect(all[0]?.name).toBe("Vacation.jpg")
            expect(all[1]?.name).toBe("Sunset.jpg")
          })

          yield* program.pipe(Effect.provide(repoLayer))
        }),
      ),
    )

    it.effect("PhotoRepoMemoryLayer operates in memory and decodes Photo schemas", () =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const repo = yield* PhotoRepo
          const p1 = yield* repo.insert({
            name: PhotoName.make("Memory.png"),
            albumId: AlbumId.make("a-mem"),
          })
          expect(p1.id).toBe(1)
          expect(p1.name).toBe("Memory.png")

          const fetched = yield* repo.findById(PhotoId.make(1))
          expect(fetched.name).toBe("Memory.png")

          const missing = yield* Effect.flip(repo.findById(PhotoId.make(404)))
          expect(missing._tag).toBe("PhotoNotFoundError")

          const all = yield* repo.listAll
          expect(all).toHaveLength(1)
        })

        yield* program.pipe(Effect.provide(PhotoRepoMemoryLayer))
      }),
    )
  })

  // Test 2: AlbumCounterStore SQLite upsert & SqliteMigrator idempotency against real workerd
  describe("AlbumCounterStore & SqliteMigrator", () => {
    it.effect(
      "runs albumCounterMigrations idempotently and upserts counts in workerd DO SQLite",
      () =>
        Effect.gen(function* () {
          expect(Object.keys(albumCounterMigrations)).toEqual(["1_init_album_counters"])

          const firstRun = yield* initializeAlbumCounterTables()
          expect(firstRun).toEqual([[1, "init_album_counters"]])

          // Re-running is a no-op
          const secondRun = yield* initializeAlbumCounterTables()
          expect(secondRun).toEqual([])

          const sql = yield* SqlClient
          const recordedMigrations = yield* sql<{
            readonly migration_id: number
            readonly name: string
          }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC;
        `
          expect(recordedMigrations).toEqual([{ migration_id: 1, name: "init_album_counters" }])

          // Test ActiveCounterStore get & upsert
          const storeProgram = Effect.gen(function* () {
            const store = yield* ActiveCounterStore
            const albumId = AlbumId.make("album-upsert")

            const initial = yield* store.get(albumId)
            expect(initial).toBe(0)

            yield* store.set(albumId, AlbumPhotoCount.make(1))
            expect(yield* store.get(albumId)).toBe(1)

            yield* store.set(albumId, AlbumPhotoCount.make(42))
            expect(yield* store.get(albumId)).toBe(42)
          })

          yield* storeProgram.pipe(Effect.provide(makeAlbumCounterDoLayer(sql)))
        }).pipe(Effect.provide(SqlClientMemoryLayer)),
    )

    it.effect("upserts AlbumCounterStore counts in workerd D1", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const d1 = yield* createWorkerdD1Database()

          const storeProgram = Effect.gen(function* () {
            const store = yield* ActiveCounterStore
            const albumId = AlbumId.make("album-d1-upsert")

            expect(yield* store.get(albumId)).toBe(0)
            yield* store.set(albumId, AlbumPhotoCount.make(3))
            expect(yield* store.get(albumId)).toBe(3)
            yield* store.set(albumId, AlbumPhotoCount.make(7))
            expect(yield* store.get(albumId)).toBe(7)
          })

          yield* storeProgram.pipe(Effect.provide(makeAlbumCounterDoLayer(d1)))
        }),
      ),
    )
  })

  // Test 3: Distributed W3C traceparent correlation across Worker/DO boundary
  describe("distributed W3C traceparent correlation", () => {
    it.effect("propagates traceparent header and links remote DO spans into test trace graph", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const testHostIo: SyncHostIo = {
            existsSync: (p) => nodeFs.existsSync(p),
            isFileSync: (p) =>
              Result.getOrElse(
                Result.try(() => nodeFs.statSync(p).isFile()),
                () => false,
              ),
            isDirectorySync: (p) =>
              Result.getOrElse(
                Result.try(() => nodeFs.statSync(p).isDirectory()),
                () => false,
              ),
            isSymbolicLinkSync: (p) =>
              Result.getOrElse(
                Result.try(() => nodeFs.lstatSync(p).isSymbolicLink()),
                () => false,
              ),
            readTextSync: (p) => nodeFs.readFileSync(p, "utf8"),
            readBytesSync: (p) => nodeFs.readFileSync(p),
            writeTextSync: (p, c) => {
              nodeFs.writeFileSync(p, c, "utf8")
            },
            appendTextSync: (p, c) => {
              nodeFs.appendFileSync(p, c, "utf8")
            },
            mkdirRecursiveSync: (p, m) => {
              nodeFs.mkdirSync(
                p,
                m === undefined ? { recursive: true } : { recursive: true, mode: m },
              )
            },
            renameSync: (a, b) => {
              nodeFs.renameSync(a, b)
            },
            unlinkSync: (p) => {
              nodeFs.unlinkSync(p)
            },
            readdirSync: (p) =>
              nodeFs
                .readdirSync(p, { withFileTypes: true })
                .map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })),
            realpathSync: (p) => nodeFs.realpathSync(p),
            getEnv: () => process.env,
            execFileSync: () => ({
              _tag: "Exited",
              exitCode: 1,
              stdout: "",
              stderr: "unused in unit test",
            }),
          }

          const testId = "libs/sample/infra/test/index.test.ts::distributed traceparent correlation"
          const repoRoot = resolveRepoRoot(process.cwd())
          const fnIndex = yield* buildWorkspaceFnIndex(repoRoot, testHostIo)

          const d1 = yield* createWorkerdD1Database()
          const sql = yield* SqlClient.pipe(Effect.provide(D1Client.layer({ db: d1 })))

          const doRpcHandler = makeAlbumCounterRpcHandler(sql)
          const httpClient = toHttpClient(doRpcHandler)
          const albumCounterLayer = makeAlbumCounterRpcClient(httpClient)

          const testLayer = Layer.mergeAll(albumCounterLayer, PhotoRepoMemoryLayer)

          const { result, edges, spans } = yield* runWithTestTracer(
            testId,
            uploadPhoto({
              name: PhotoName.make("Nature.jpg"),
              albumId: AlbumId.make("album-nature"),
            }).pipe(Effect.provide(testLayer)),
            fnIndex.bySpanName,
          )

          expect(result.id).toBe(1)
          expect(result.name).toBe("Nature.jpg")
          expect(result.albumId).toBe("album-nature")

          // Verify real workerd D1 database has genuine persisted count row in album_counters table
          const countResult = yield* Effect.promise(() =>
            d1
              .prepare("SELECT * FROM album_counters WHERE album_id = ?")
              .bind("album-nature")
              .all<{ readonly album_id: string; readonly count: number }>(),
          )
          expect(countResult.results).toHaveLength(1)
          expect(countResult.results[0]?.count).toBe(1)

          // Verify all recorded spans share the exact same traceId as the root Test: span
          const rootSpan = spans.find((s) => s.name.startsWith("Test:"))
          expect(rootSpan).toBeDefined()
          const expectedTraceId = rootSpan!.traceId

          for (const span of spans) {
            expect(span.traceId).toBe(expectedTraceId)
          }

          // Verify individual span names exist
          const spanNames = spans.map((s) => s.name)
          expect(spanNames).toContain("Sample.uploadPhoto")
          expect(spanNames).toContain("SampleInfra.handleAlbumCounterRpc")
          expect(spanNames).toContain("Album.decide")

          // Verify exercisesSpans edges
          const uploadPhotoQualname = fnIndex.bySpanName.get("Sample.uploadPhoto")?.qualname
          const handleAlbumCounterRpcQualname = fnIndex.bySpanName.get(
            "SampleInfra.handleAlbumCounterRpc",
          )?.qualname
          const decideAlbumQuotaQualname = fnIndex.bySpanName.get("Album.decide")?.qualname

          expect(uploadPhotoQualname).toBeDefined()
          expect(handleAlbumCounterRpcQualname).toBeDefined()
          expect(decideAlbumQuotaQualname).toBeDefined()

          expect(edges.exercisesSpans.some((e) => e.calleeQualname === uploadPhotoQualname)).toBe(
            true,
          )
          expect(
            edges.exercisesSpans.some((e) => e.calleeQualname === handleAlbumCounterRpcQualname),
          ).toBe(true)
          expect(
            edges.exercisesSpans.some((e) => e.calleeQualname === decideAlbumQuotaQualname),
          ).toBe(true)

          // Verify tracedCalls joins caller to callee
          const hasUploadToRpcCall = edges.tracedCalls.some(
            (e) =>
              e.callerQualname === uploadPhotoQualname &&
              e.calleeQualname === handleAlbumCounterRpcQualname,
          )
          expect(hasUploadToRpcCall).toBe(true)

          const hasRpcToDecideCall = edges.tracedCalls.some(
            (e) =>
              e.callerQualname === handleAlbumCounterRpcQualname &&
              e.calleeQualname === decideAlbumQuotaQualname,
          )
          expect(hasRpcToDecideCall).toBe(true)
        }),
      ),
    )

    it.effect("propagates AlbumQuotaExceededError across RPC when quota reached", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const d1 = yield* createWorkerdD1Database()
          // Pre-populate album_counters with count 100 in workerd D1
          yield* Effect.promise(() =>
            d1
              .prepare("INSERT INTO album_counters (album_id, count) VALUES (?, ?)")
              .bind("album-full", 100)
              .run(),
          )

          const sql = yield* SqlClient.pipe(Effect.provide(D1Client.layer({ db: d1 })))

          const doRpcHandler = makeAlbumCounterRpcHandler(sql)
          const httpClient = toHttpClient(doRpcHandler)
          const client = makeAlbumCounterRpcClient(httpClient)

          const error = yield* Effect.flip(client.increment(AlbumId.make("album-full")))
          expect(error).toMatchObject({
            _tag: "AlbumQuotaExceededError",
            albumId: "album-full",
            count: 100,
          })
        }),
      ),
    )

    it.effect("atomically enforces quota under concurrent increment calls on workerd D1", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const d1 = yield* createWorkerdD1Database()
          yield* Effect.promise(() =>
            d1
              .prepare("INSERT INTO album_counters (album_id, count) VALUES (?, ?)")
              .bind("album-race", 99)
              .run(),
          )

          const sql = yield* SqlClient.pipe(Effect.provide(D1Client.layer({ db: d1 })))
          const doRpcHandler = makeAlbumCounterRpcHandler(sql)
          const client = makeAlbumCounterRpcClient(toHttpClient(doRpcHandler))

          const results = yield* Effect.all(
            Array.from({ length: 4 }, () =>
              Effect.exit(client.increment(AlbumId.make("album-race"))),
            ),
            { concurrency: "unbounded" },
          )

          const successes = results.filter((r) => r._tag === "Success")
          const failures = results.filter((r) => r._tag === "Failure")
          expect(successes).toHaveLength(1)
          expect(failures).toHaveLength(3)
        }),
      ),
    )

    it.effect(
      "incrementWithQuota enforces 99 -> 100 and reports real stored count at 100 and 105",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const d1 = yield* createWorkerdD1Database()
            const sql = yield* SqlClient.pipe(Effect.provide(D1Client.layer({ db: d1 })))
            const store = makeAlbumCounterStoreSql(sql)

            const albumA = AlbumId.make("album-99")
            yield* store.set(albumA, AlbumPhotoCount.make(99))
            const at100 = yield* store.incrementWithQuota(albumA)
            expect(at100).toBe(100)

            const err100 = yield* Effect.flip(store.incrementWithQuota(albumA))
            expect(err100).toMatchObject({ _tag: "AlbumQuotaExceededError", count: 100 })

            const albumOver = AlbumId.make("album-105")
            yield* store.set(albumOver, AlbumPhotoCount.make(105))
            const err105 = yield* Effect.flip(store.incrementWithQuota(albumOver))
            expect(err105).toMatchObject({ _tag: "AlbumQuotaExceededError", count: 105 })

            const decremented = yield* store.decrement(albumA)
            expect(decremented).toBe(99)
          }),
        ),
    )

    it.effect(
      "RPC handler returns 400 on malformed JSON, missing action, bad schema, and 500 on SQL failure",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const d1 = yield* createWorkerdD1Database()
            const sql = yield* SqlClient.pipe(Effect.provide(D1Client.layer({ db: d1 })))
            const handler = makeAlbumCounterRpcHandler(sql)

            // 1. Malformed JSON -> 400 invalid_json
            const badJsonRes = yield* handler.fetch(
              new Request("http://localhost/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{not-json",
              }),
            )
            expect(badJsonRes.status).toBe(400)

            // 2. Missing action -> 400 invalid_request (without mutating count!)
            const missingActionRes = yield* handler.fetch(
              new Request("http://localhost/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ albumId: "album-no-mutate" }),
              }),
            )
            expect(missingActionRes.status).toBe(400)
            const store = makeAlbumCounterStoreSql(sql)
            expect(yield* store.get(AlbumId.make("album-no-mutate"))).toBe(0)

            // 3. Bad schema payload -> 400 invalid_request
            const badPayloadRes = yield* handler.fetch(
              new Request("http://localhost/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "IncrementAlbumCount", albumId: 12345 }),
              }),
            )
            expect(badPayloadRes.status).toBe(400)

            // 4. handleAlbumCounterRpc without ActiveCounterStore -> AlbumCounterStorageError
            const missingStoreErr = yield* Effect.flip(
              handleAlbumCounterRpc({ action: "GetAlbumCount", albumId: "album-x" }),
            )
            expect(missingStoreErr._tag).toBe("AlbumCounterStorageError")

            // 5. SQL failure -> 500 storage_failure (redacted, no SQL text leaked)
            const emptyD1 = yield* createWorkerdD1Database({ skipSchema: true })
            const emptySql = yield* SqlClient.pipe(Effect.provide(D1Client.layer({ db: emptyD1 })))
            const failingHandler = makeAlbumCounterRpcHandler(emptySql)
            const sqlFailRes = yield* failingHandler.fetch(
              new Request("http://localhost/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "GetAlbumCount", albumId: "album-x" }),
              }),
            )
            expect(sqlFailRes.status).toBe(500)
            const sqlFailBody = yield* Effect.promise(() =>
              HttpServerResponse.toWeb(sqlFailRes).text(),
            )
            expect(sqlFailBody).not.toContain("no such table")
            expect(sqlFailBody).not.toContain("SELECT")
            expect(JSON.parse(sqlFailBody)).toEqual({
              error: "storage_failure",
              message: "Counter storage operation failed",
            })

            // 6. Client non-200 handling on getCount, increment, decrement
            const failingClient = makeAlbumCounterRpcClient(toHttpClient(failingHandler))
            const getCountErr = yield* Effect.flip(failingClient.getCount(AlbumId.make("album-x")))
            expect(getCountErr).toMatchObject({ _tag: "AlbumCounterProtocolError", status: 500 })

            const incrementErr = yield* Effect.flip(
              failingClient.increment(AlbumId.make("album-x")),
            )
            expect(incrementErr).toMatchObject({ _tag: "AlbumCounterProtocolError", status: 500 })

            const decrementErr = yield* Effect.flip(
              failingClient.decrement(AlbumId.make("album-x")),
            )
            expect(decrementErr).toMatchObject({ _tag: "AlbumCounterProtocolError", status: 500 })
          }),
        ),
    )

    it.effect(
      "F-20: bounds >8192-char underlying errors cleanly to PhotoStorageError, AlbumCounterStorageError, and AlbumCounterProtocolError",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const d1 = yield* createWorkerdD1Database()
            const sql = yield* SqlClient.pipe(Effect.provide(D1Client.layer({ db: d1 })))
            const longText = "E".repeat(12_000)

            // 1. PhotoStorageError: >8192-char SqlError
            const failingSql = yield* SqlClientModule.make({
              acquirer: Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.UnknownError({
                    cause: new Error(longText),
                    message: longText,
                  }),
                }),
              ),
              compiler: Statement.makeCompilerSqlite(),
              spanAttributes: [],
            }).pipe(Effect.provide(Reactivity.layer))
            const photoRepo = yield* PhotoRepo.pipe(
              Effect.provide(makePhotoRepoD1Layer(failingSql)),
            )
            const photoErr = yield* Effect.flip(
              photoRepo.insert({
                name: PhotoName.make("sunset.png"),
                albumId: AlbumId.make("album-long-err"),
              }),
            )
            expect(photoErr._tag).toBe("PhotoStorageError")
            expect(photoErr.message.length).toBeLessThanOrEqual(8192)
            expect(photoErr.message.length).toBe(8192)

            // 2. AlbumCounterStorageError: corrupt >8192-char count triggers >8192-char decode error
            yield* Effect.promise(() =>
              d1
                .prepare("INSERT INTO album_counters (album_id, count) VALUES (?, ?)")
                .bind("album-long-count", longText)
                .run(),
            )
            const store = makeAlbumCounterStoreSql(sql)
            const counterErr = yield* Effect.flip(store.get(AlbumId.make("album-long-count")))
            expect(counterErr._tag).toBe("AlbumCounterStorageError")
            expect(counterErr.message.length).toBeLessThanOrEqual(8192)
            expect(counterErr.message.length).toBe(8192)

            // 3. AlbumCounterProtocolError: >8192-char HTTP error body
            const oversizedFetcher = {
              fetch: () => Effect.succeed(HttpServerResponse.text(longText, { status: 502 })),
            }
            const client = makeAlbumCounterRpcClient(toHttpClient(oversizedFetcher))
            const protoErr = yield* Effect.flip(client.getCount(AlbumId.make("album-x")))
            expect(protoErr).toMatchObject({ _tag: "AlbumCounterProtocolError", status: 502 })
            expect(protoErr.message.length).toBeLessThanOrEqual(8192)
            expect(protoErr.message.length).toBe(8192)
          }),
        ),
    )
  })
})
