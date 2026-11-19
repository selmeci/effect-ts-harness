import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  AlbumId,
  AlbumPhotoCount,
  AlbumQuotaExceededError,
  buildOpenApiSpec,
  CreatedAtMillis,
  CreatePhotoInput,
  DecideAlbumQuotaInput,
  GreetingMessage,
  Photo,
  PhotoCounterRpc,
  PhotoId,
  PhotoIdFromString,
  PhotoName,
  PhotoNotFoundError,
  SampleApi,
} from "../src/index.js"

const currentDir = import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url))
const repoRoot = resolve(currentDir, "../../../..")
const harnessCliEntryPath = resolve(repoRoot, "apps/harness-cli/src/index.ts")
const resolverPath = resolve(repoRoot, "tools/node-ts-resolver.mjs")
const openApiPath = resolve(currentDir, "../openapi.json")

describe("sample-contract (Schemas, HttpApi, RpcGroup, OpenAPI)", () => {
  it("constructs branded GreetingMessage", () => {
    const message = GreetingMessage.make("Hello, Roman!")
    expect(message).toBe("Hello, Roman!")
    expect(Schema.decodeSync(GreetingMessage)("Hello, Roman!")).toBe(message)
  })

  it("decodes Photo, CreatePhotoInput, DecideAlbumQuotaInput, and PhotoIdFromString branded Schemas", () => {
    const input = Schema.decodeSync(CreatePhotoInput)({ name: "sunset.jpg", albumId: "vacation" })
    expect(input.albumId).toBe(AlbumId.make("vacation"))
    expect(input.name).toBe(PhotoName.make("sunset.jpg"))
    const quotaInput = Schema.decodeSync(DecideAlbumQuotaInput)({
      albumId: "vacation",
      currentCount: 0,
    })
    expect(quotaInput.albumId).toBe(AlbumId.make("vacation"))
    expect(quotaInput.currentCount).toBe(AlbumPhotoCount.make(0))
    const photo = Schema.decodeSync(Photo)({
      id: 1,
      name: "sunset.jpg",
      albumId: "vacation",
      createdAt: 1700000000,
    })
    expect(photo.id).toBe(PhotoId.make(1))
    expect(photo.createdAt).toBe(CreatedAtMillis.make(1700000000))
    const idFromParam = Schema.decodeSync(PhotoIdFromString)("42")
    expect(idFromParam).toBe(PhotoId.make(42))
  })

  it("rejects non-integer and non-positive values in PhotoId and PhotoIdFromString, and negative values in AlbumPhotoCount", () => {
    expect(() => Schema.decodeSync(PhotoIdFromString)("1.5")).toThrow()
    expect(() => Schema.decodeSync(PhotoIdFromString)("-3")).toThrow()
    expect(() => Schema.decodeSync(PhotoIdFromString)("0")).toThrow()
    expect(() => PhotoId.make(0)).toThrow()
    expect(() => PhotoId.make(-1)).toThrow()
    expect(() => PhotoId.make(1.5)).toThrow()

    expect(() => Schema.decodeSync(AlbumPhotoCount)(-1)).toThrow()
    expect(() => Schema.decodeSync(AlbumPhotoCount)(1.5)).toThrow()
    expect(() => AlbumPhotoCount.make(-1)).toThrow()
    expect(AlbumPhotoCount.make(0)).toBe(0)
  })

  it("constructs PhotoNotFoundError and AlbumQuotaExceededError with branded fields", () => {
    const notFound = new PhotoNotFoundError({ id: PhotoId.make(42) })
    expect(notFound._tag).toBe("PhotoNotFoundError")
    expect(notFound.id).toBe(42)

    const quota = new AlbumQuotaExceededError({
      albumId: AlbumId.make("vacation"),
      count: AlbumPhotoCount.make(100),
    })
    expect(quota._tag).toBe("AlbumQuotaExceededError")
    expect(quota.albumId).toBe("vacation")
    expect(quota.count).toBe(100)
  })

  it("exports SampleApi HttpApi, PhotoCounterRpc RpcGroup, and an up-to-date openapi.json", () => {
    expect(SampleApi).toBeDefined()
    expect(PhotoCounterRpc).toBeDefined()
    const liveSpec = buildOpenApiSpec()
    const committed = JSON.parse(readFileSync(openApiPath, "utf8"))
    expect(liveSpec).toEqual(committed)
  })

  it("harness-cli check-openapi exits 0 on fresh openapi.json and 1 when stale", () => {
    const freshRes = spawnSync(
      process.execPath,
      ["--import", resolverPath, harnessCliEntryPath, "check-openapi"],
      { cwd: repoRoot, encoding: "utf8" },
    )
    expect(freshRes.status).toBe(0)
    expect(freshRes.stdout).toContain("fresh")

    const tmpStaleFile = resolve(
      currentDir,
      "..",
      `.tmp-stale-openapi-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    )
    try {
      writeFileSync(tmpStaleFile, JSON.stringify({ openapi: "3.1.0", paths: {} }), "utf8")
      const staleRes = spawnSync(
        process.execPath,
        [
          "--import",
          resolverPath,
          harnessCliEntryPath,
          "check-openapi",
          "--out",
          relative(repoRoot, tmpStaleFile),
        ],
        { cwd: repoRoot, encoding: "utf8" },
      )
      expect(staleRes.status).toBe(1)
      expect(staleRes.stderr).toContain("stale")
    } finally {
      rmSync(tmpStaleFile, { force: true })
    }
  })
})
