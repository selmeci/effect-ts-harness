import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { buildWorkspaceFnIndex, runWithTestTracer } from "@harness/ingest"
import {
  buildHarnessGraph,
  findTestsReaching,
  loadGraphSnapshot,
  saveGraphSnapshot
} from "@harness/graph"
import {
  type CreatePhotoInput,
  type Photo,
  AlbumQuotaExceededError,
  PhotoNotFoundError
} from "@harness/sample-contract"
import { AlbumCounterClient, PhotoRepo } from "@harness/sample-service"
import {
  decideAlbumQuota,
  getPhotoById,
  greet,
  listPhotos,
  uploadPhoto
} from "../src/index.js"

const resolveRepoRoot = (startDir: string): string => {
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = path.dirname(curr)
  }
  return startDir
}

describe("greet", () => {
  it.effect("greets by name", () =>
    Effect.gen(function* () {
      const testId = "libs/sample/domain/test/index.test.ts::greets by name"
      const repoRoot = resolveRepoRoot(process.cwd())
      const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)

      const { result, edges } = yield* runWithTestTracer(
        testId,
        greet({ name: "Roman" }),
        fnIndex.bySpanName
      )
      expect(result).toBe("Hello, Roman!")

      const fns = Array.from(fnIndex.bySpanName.values()).map((fn) => ({
        qualname: fn.qualname,
        spanName: fn.spanName,
        file: fn.file,
        line: fn.line,
        packageTag: fn.packageTag,
        successType: "string",
        isStub: fn.isStub
      }))

      const tests = [
        {
          testId,
          testFile: "libs/sample/domain/test/index.test.ts",
          testName: "greets by name",
          lastTreeHash: "current"
        }
      ]

      const graph = buildHarnessGraph({
        fns,
        services: [],
        layers: [],
        errors: [],
        tests,
        patternDocs: [],
        exercisesSpans: edges.exercisesSpans,
        tracedCalls: edges.tracedCalls
      })

      if (process.env.HARNESS_TRACE === "1") {
        const snapshotPath = path.join(repoRoot, ".harness", "graph-snapshot.json")
        saveGraphSnapshot(graph, snapshotPath)
        const loadedGraph = loadGraphSnapshot(snapshotPath)
        const reachingFromLoaded = findTestsReaching(loadedGraph, "Sample.greet")
        expect(reachingFromLoaded.map((t) => t.testId)).toContain(testId)
      }

      const reaching = findTestsReaching(graph, "Sample.greet")
      expect(reaching.map((t) => t.testId)).toContain(testId)
    })
  )
})

describe("decideAlbumQuota", () => {
  it.effect("succeeds with currentCount + 1 when below quota (R = never)", () =>
    Effect.gen(function* () {
      // Runs with zero Layers (R = never)
      const nextCount = yield* decideAlbumQuota({
        albumId: "album-vacation",
        currentCount: 42
      })
      expect(nextCount).toBe(43)

      const atLimitMinusOne = yield* decideAlbumQuota({
        albumId: "album-vacation",
        currentCount: 99
      })
      expect(atLimitMinusOne).toBe(100)
    })
  )

  it.effect("fails with AlbumQuotaExceededError when count >= 100", () =>
    Effect.gen(function* () {
      const errAt100 = yield* Effect.flip(
        decideAlbumQuota({
          albumId: "album-vacation",
          currentCount: 100
        })
      )
      expect(errAt100).toBeInstanceOf(AlbumQuotaExceededError)
      expect(errAt100._tag).toBe("AlbumQuotaExceededError")
      expect(errAt100.albumId).toBe("album-vacation")
      expect(errAt100.count).toBe(100)

      const errAt150 = yield* Effect.flip(
        decideAlbumQuota({
          albumId: "album-party",
          currentCount: 150
        })
      )
      expect(errAt150).toBeInstanceOf(AlbumQuotaExceededError)
      expect(errAt150._tag).toBe("AlbumQuotaExceededError")
      expect(errAt150.albumId).toBe("album-party")
      expect(errAt150.count).toBe(150)
    })
  )

  it.effect.prop(
    "enforces quota invariant and monotonicity across generated inputs",
    {
      albumId: Schema.NonEmptyString,
      currentCount: Schema.Int.check(
        Schema.isBetween({ minimum: -50, maximum: 250 })
      )
    },
    ({ albumId, currentCount }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decideAlbumQuota({ albumId, currentCount })
        )
        if (currentCount >= 100) {
          expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
          const err = yield* Effect.flip(
            decideAlbumQuota({ albumId, currentCount })
          )
          expect(err._tag).toBe("AlbumQuotaExceededError")
          expect(err.albumId).toBe(albumId)
          expect(err.count).toBe(currentCount)
        } else {
          expect(Exit.isSuccess(exit)).toBe(true)
          const next = yield* decideAlbumQuota({ albumId, currentCount })
          expect(next).toBe(currentCount + 1)
        }
      })
  )
})

const makeTestLayers = (initialCount = 0) => {
  const photos: Array<Photo> = []
  let nextId = 1
  let count = initialCount

  const photoRepoLayer = Layer.succeed(PhotoRepo, {
    insert: (input: CreatePhotoInput) =>
      Effect.sync(() => {
        const photo: Photo = {
          id: nextId++,
          name: input.name,
          albumId: input.albumId,
          createdAt: 1000
        }
        photos.push(photo)
        return photo
      }),
    findById: (id: number) =>
      Effect.gen(function* () {
        const found = photos.find((p) => p.id === id)
        if (!found) {
          return yield* new PhotoNotFoundError({ id })
        }
        return found
      }),
    listAll: Effect.sync(() => [...photos])
  })

  const albumCounterLayer = Layer.succeed(AlbumCounterClient, {
    increment: (_albumId: string) =>
      Effect.sync(() => {
        count++
        return count
      }),
    getCount: (_albumId: string) => Effect.sync(() => count)
  })

  const testLayer = Layer.merge(photoRepoLayer, albumCounterLayer)
  return { testLayer, photos, getCount: () => count }
}

describe("uploadPhoto", () => {
  it.effect("uploads photo and records tracedCalls edge to Album.decide", () =>
    Effect.gen(function* () {
      const testId = "libs/sample/domain/test/index.test.ts::uploads photo with traced calls"
      const repoRoot = resolveRepoRoot(process.cwd())
      const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
      const { testLayer, photos, getCount } = makeTestLayers(5)

      const { result, edges } = yield* runWithTestTracer(
        testId,
        uploadPhoto({ name: "Sunset.jpg", albumId: "album-nature" }).pipe(
          Effect.provide(testLayer)
        ),
        fnIndex.bySpanName
      )

      expect(result.id).toBe(1)
      expect(result.name).toBe("Sunset.jpg")
      expect(result.albumId).toBe("album-nature")
      expect(photos).toHaveLength(1)
      expect(getCount()).toBe(6)

      const uploadPhotoQualname = fnIndex.bySpanName.get("Sample.uploadPhoto")?.qualname
      const decideAlbumQuotaQualname = fnIndex.bySpanName.get("Album.decide")?.qualname

      expect(uploadPhotoQualname).toBeDefined()
      expect(decideAlbumQuotaQualname).toBeDefined()

      // Assert tracedCalls records Sample.uploadPhoto -> Album.decide
      const hasTracedCall = edges.tracedCalls.some(
        (e) =>
          e.callerQualname === uploadPhotoQualname &&
          e.calleeQualname === decideAlbumQuotaQualname
      )
      expect(hasTracedCall).toBe(true)

      // Assert exercisesSpans records both spans
      expect(edges.exercisesSpans.some((e) => e.calleeQualname === uploadPhotoQualname)).toBe(true)
      expect(edges.exercisesSpans.some((e) => e.calleeQualname === decideAlbumQuotaQualname)).toBe(true)
    })
  )

  it.effect("fails when album quota is reached without inserting photo", () =>
    Effect.gen(function* () {
      const { testLayer, photos, getCount } = makeTestLayers(100)

      const error = yield* Effect.flip(
        uploadPhoto({ name: "OverLimit.jpg", albumId: "album-full" }).pipe(
          Effect.provide(testLayer)
        )
      )

      expect(error._tag).toBe("AlbumQuotaExceededError")
      expect(error.albumId).toBe("album-full")
      expect(error.count).toBe(100)
      expect(photos).toHaveLength(0)
      expect(getCount()).toBe(100)
    })
  )
})

describe("getPhotoById & listPhotos", () => {
  it.effect("retrieves photo by id and lists all photos", () =>
    Effect.gen(function* () {
      const { testLayer } = makeTestLayers()

      const created = yield* uploadPhoto({ name: "Mountains.jpg", albumId: "travel" }).pipe(
        Effect.provide(testLayer)
      )

      const fetched = yield* getPhotoById(created.id).pipe(
        Effect.provide(testLayer)
      )
      expect(fetched).toEqual(created)

      const all = yield* listPhotos().pipe(
        Effect.provide(testLayer)
      )
      expect(all).toEqual([created])
    })
  )

  it.effect("fails with PhotoNotFoundError when photo does not exist", () =>
    Effect.gen(function* () {
      const { testLayer } = makeTestLayers()

      const error = yield* Effect.flip(
        getPhotoById(999).pipe(
          Effect.provide(testLayer)
        )
      )

      expect(error._tag).toBe("PhotoNotFoundError")
      expect(error.id).toBe(999)
    })
  )
})
