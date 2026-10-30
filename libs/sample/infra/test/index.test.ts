import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { DatabaseSync } from "node:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { D1Client } from "@effect/sql-d1"
import { makeWithDefaults } from "drizzle-orm/effect-d1"
import { buildWorkspaceFnIndex, runWithTestTracer } from "@harness/ingest"
import { uploadPhoto } from "@harness/sample-domain"
import { PhotoRepo } from "@harness/sample-service"
import { albumCounters, photos } from "../src/db/schema.js"
import {
  logToConsole,
  makeAlbumCounterRpcClient,
  makeAlbumCounterRpcHandler,
  makePhotoRepoD1Layer,
  PhotoRepoMemoryLayer,
  toHttpClient
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
type D1PreparedStatement = ReturnType<D1Database["prepare"]>
type D1Result<T> = Awaited<ReturnType<D1PreparedStatement["all"]>> extends { results: Array<unknown> }
  ? Omit<Awaited<ReturnType<D1PreparedStatement["all"]>>, "results"> & { results: Array<T> }
  : never

const createMockD1Database = (): {
  sqlite: DatabaseSync
  mockD1: D1Database
} => {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(`
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      album_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE album_counters (
      album_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL
    );
  `)

  const createMeta = () => ({
    served_by: "local",
    duration: 0,
    changes: 0,
    last_row_id: 0,
    changed_db: false,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    sql_duration_ms: 0
  })

  const createStatement = (
    sql: string,
    boundParams: Array<string | number | bigint | Buffer | null> = []
  ): D1PreparedStatement => {
    function raw<T = Array<unknown>>(options: { columnNames: true }): Promise<[Array<string>, ...Array<T>]>
    function raw<T = Array<unknown>>(options?: { columnNames?: false }): Promise<Array<T>>
    async function raw<T = Array<unknown>>(options?: {
      columnNames?: boolean
    }): Promise<[Array<string>, ...Array<T>] | Array<T>> {
      const stmt = sqlite.prepare(sql)
      const rows = stmt
        .all(...boundParams)
        .map((row: Record<string, unknown>) => Object.values(row) as T)
      if (options?.columnNames === true) {
        return [[] as Array<string>, ...rows]
      }
      return rows
    }

    function first<T = unknown>(colName: string): Promise<T | null>
    function first<T = Record<string, unknown>>(): Promise<T | null>
    async function first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
      const stmt = sqlite.prepare(sql)
      const results = stmt.all(...boundParams)
      const row = results[0] as Record<string, unknown> | undefined
      if (!row) return null
      if (typeof colName === "string") {
        return (row[colName] as T | undefined) ?? null
      }
      return row as T
    }

    const statement: D1PreparedStatement = {
      bind(...params: Array<unknown>) {
        return createStatement(
          sql,
          params as Array<string | number | bigint | Buffer | null>
        )
      },
      all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        const stmt = sqlite.prepare(sql)
        const results = stmt.all(...boundParams) as Array<T>
        return {
          results,
          success: true,
          meta: createMeta()
        }
      },
      raw,
      first,
      run: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        const stmt = sqlite.prepare(sql)
        const results = stmt.all(...boundParams) as Array<T>
        return {
          results,
          success: true,
          meta: createMeta()
        }
      }
    }
    return statement
  }

  const mockD1: D1Database = {
    prepare(sql: string) {
      return createStatement(sql)
    },
    batch: async <T = unknown>(statements: Array<D1PreparedStatement>): Promise<Array<D1Result<T>>> =>
      Promise.all(statements.map((s) => s.all<T>())),
    exec: async (query: string) => {
      sqlite.exec(query)
      return { count: 0, duration: 0 }
    },
    withSession() {
      return {
        prepare: (sql: string) => createStatement(sql),
        batch: <T = unknown>(statements: Array<D1PreparedStatement>) => mockD1.batch<T>(statements),
        getBookmark: () => null
      }
    },
    dump: async () => new ArrayBuffer(0)
  }

  return { sqlite, mockD1 }
}

describe("sample-infra", () => {
  it.effect("runs logToConsole without failing", () =>
    Effect.gen(function* () {
      yield* logToConsole("harness")
      expect(photos.id.name).toBe("id")
    })
  )

  it("resolves drizzle-orm/effect-d1 from the 1.0.0-rc.5 pin", async () => {
    const mod = await import("drizzle-orm/effect-d1")
    expect(mod).toBeDefined()
  })

  // Test 1: PhotoRepo backed by Drizzle SQLite / D1 queries
  describe("PhotoRepo", () => {
    it.effect("inserts, fetches by ID, lists all photos, and decodes into Photo schema", () =>
      Effect.scoped(
        Effect.gen(function* () {
        const { mockD1 } = createMockD1Database()
        const drizzleDb = yield* makeWithDefaults({}).pipe(
          Effect.provide(D1Client.layer({ db: mockD1 }))
        )

        const repoLayer = makePhotoRepoD1Layer(drizzleDb)

        const program = Effect.gen(function* () {
          const repo = yield* PhotoRepo

          // Insert photo
          const created = yield* repo.insert({
            name: "Vacation.jpg",
            albumId: "album-1"
          })

          expect(created.id).toBe(1)
          expect(created.name).toBe("Vacation.jpg")
          expect(created.albumId).toBe("album-1")
          expect(typeof created.createdAt).toBe("number")

          // Find by ID
          const fetched = yield* repo.findById(created.id)
          expect(fetched).toEqual(created)

          // Find missing by ID should fail with PhotoNotFoundError
          const missingError = yield* Effect.flip(repo.findById(999))
          expect(missingError._tag).toBe("PhotoNotFoundError")
          expect(missingError.id).toBe(999)

          // Insert second photo
          yield* repo.insert({
            name: "Sunset.jpg",
            albumId: "album-1"
          })

          // List all photos
          const all = yield* repo.listAll
          expect(all).toHaveLength(2)
          expect(all[0]?.name).toBe("Vacation.jpg")
          expect(all[1]?.name).toBe("Sunset.jpg")
        })

        yield* program.pipe(Effect.provide(repoLayer))
      })
      )
    )

    it.effect("PhotoRepoMemoryLayer operates in memory and decodes Photo schemas", () =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const repo = yield* PhotoRepo
          const p1 = yield* repo.insert({ name: "Memory.png", albumId: "a-mem" })
          expect(p1.id).toBe(1)
          expect(p1.name).toBe("Memory.png")

          const fetched = yield* repo.findById(1)
          expect(fetched.name).toBe("Memory.png")

          const missing = yield* Effect.flip(repo.findById(404))
          expect(missing._tag).toBe("PhotoNotFoundError")

          const all = yield* repo.listAll
          expect(all).toHaveLength(1)
        })

        yield* program.pipe(Effect.provide(PhotoRepoMemoryLayer))
      })
    )
  })

  // Test 2: Compile-time type safety test
  describe("schema compile-time type safety", () => {
    it("enforces schema types with compile-time checks", () => {
      // @ts-expect-error non_existent_column should not exist on photos table
      const _badPhotoCol = photos.nonExistentColumn
      // @ts-expect-error non_existent_column should not exist on albumCounters table
      const _badCounterCol = albumCounters.nonExistentColumn

      expect(photos.name.name).toBe("name")
      expect(photos.albumId.name).toBe("album_id")
      expect(photos.createdAt.name).toBe("created_at")
      expect(albumCounters.albumId.name).toBe("album_id")
      expect(albumCounters.count.name).toBe("count")
    })
  })

  // Test 3: Distributed W3C traceparent correlation across Worker/DO boundary
  describe("distributed W3C traceparent correlation", () => {
    it.effect(
      "propagates traceparent header and links remote DO spans into test trace graph",
      () =>
        Effect.gen(function* () {
          const testId =
            "libs/sample/infra/test/index.test.ts::distributed traceparent correlation"
          const repoRoot = resolveRepoRoot(process.cwd())
          const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)

          const { mockD1, sqlite } = createMockD1Database()
          const drizzleDb = yield* makeWithDefaults({}).pipe(
            Effect.provide(D1Client.layer({ db: mockD1 }))
          )

          const doRpcHandler = makeAlbumCounterRpcHandler(drizzleDb)
          const httpClient = toHttpClient(doRpcHandler)
          const albumCounterLayer = makeAlbumCounterRpcClient(httpClient)

          const testLayer = Layer.mergeAll(
            albumCounterLayer,
            PhotoRepoMemoryLayer
          )

          const { result, edges, spans } = yield* runWithTestTracer(
            testId,
            uploadPhoto({ name: "Nature.jpg", albumId: "album-nature" }).pipe(
              Effect.provide(testLayer)
            ),
            fnIndex.bySpanName
          )

          expect(result.id).toBe(1)
          expect(result.name).toBe("Nature.jpg")
          expect(result.albumId).toBe("album-nature")

          // Verify SQLite database has genuine persisted count row in album_counters table
          const countRows = sqlite
            .prepare("SELECT * FROM album_counters WHERE album_id = ?")
            .all("album-nature") as Array<{ album_id: string; count: number }>
          expect(countRows).toHaveLength(1)
          expect(countRows[0]?.count).toBe(1)

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
            "SampleInfra.handleAlbumCounterRpc"
          )?.qualname
          const decideAlbumQuotaQualname = fnIndex.bySpanName.get("Album.decide")?.qualname

          expect(uploadPhotoQualname).toBeDefined()
          expect(handleAlbumCounterRpcQualname).toBeDefined()
          expect(decideAlbumQuotaQualname).toBeDefined()

          expect(
            edges.exercisesSpans.some((e) => e.calleeQualname === uploadPhotoQualname)
          ).toBe(true)
          expect(
            edges.exercisesSpans.some(
              (e) => e.calleeQualname === handleAlbumCounterRpcQualname
            )
          ).toBe(true)
          expect(
            edges.exercisesSpans.some((e) => e.calleeQualname === decideAlbumQuotaQualname)
          ).toBe(true)

          // Verify tracedCalls joins caller to callee
          const hasUploadToRpcCall = edges.tracedCalls.some(
            (e) =>
              e.callerQualname === uploadPhotoQualname &&
              e.calleeQualname === handleAlbumCounterRpcQualname
          )
          expect(hasUploadToRpcCall).toBe(true)

          const hasRpcToDecideCall = edges.tracedCalls.some(
            (e) =>
              e.callerQualname === handleAlbumCounterRpcQualname &&
              e.calleeQualname === decideAlbumQuotaQualname
          )
          expect(hasRpcToDecideCall).toBe(true)
        })
    )

    it.effect("propagates AlbumQuotaExceededError across RPC when quota reached", () =>
      Effect.gen(function* () {
        const { mockD1, sqlite } = createMockD1Database()
        // Pre-populate album_counters with count 100
        sqlite
          .prepare("INSERT INTO album_counters (album_id, count) VALUES (?, ?)")
          .run("album-full", 100)

        const drizzleDb = yield* makeWithDefaults({}).pipe(
          Effect.provide(D1Client.layer({ db: mockD1 }))
        )

        const doRpcHandler = makeAlbumCounterRpcHandler(drizzleDb)
        const httpClient = toHttpClient(doRpcHandler)
        const client = makeAlbumCounterRpcClient(httpClient)

        const error = yield* Effect.flip(client.increment("album-full"))
        expect(error._tag).toBe("AlbumQuotaExceededError")
        expect(error.albumId).toBe("album-full")
        expect(error.count).toBe(100)
      })
    )
  })
})
