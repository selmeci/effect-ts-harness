import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { resolve } from "node:path"
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
  detectOpenApiBreakingChanges,
  GreetInput,
  GreetingMessage,
  PersonName,
  Photo,
  PhotoCounterRpc,
  PhotoId,
  PhotoIdFromString,
  PhotoName,
  PhotoNotFoundError,
  SampleApi
} from "../src/index.js"

const currentDir = import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url))
const repoRoot = resolve(currentDir, "../../../..")
const checkScriptPath = resolve(currentDir, "../scripts/check-openapi.mjs")
const resolverPath = resolve(repoRoot, "tools/node-ts-resolver.mjs")
const openApiPath = resolve(currentDir, "../openapi.json")

describe("sample-contract (Schemas, HttpApi, RpcGroup, OpenAPI)", () => {
  it("preserves GreetInput and constructs branded PersonName and GreetingMessage", () => {
    const decoded = Schema.decodeSync(GreetInput)({ name: "Roman" })
    expect(decoded.name).toBe(PersonName.make("Roman"))
    expect(GreetingMessage.make("Hello, Roman!")).toBe("Hello, Roman!")
  })

  it("decodes Photo, CreatePhotoInput, and PhotoIdFromString branded Schemas", () => {
    const input = Schema.decodeSync(CreatePhotoInput)({ name: "sunset.jpg", albumId: "vacation" })
    expect(input.albumId).toBe(AlbumId.make("vacation"))
    expect(input.name).toBe(PhotoName.make("sunset.jpg"))
    const photo = Schema.decodeSync(Photo)({
      id: 1,
      name: "sunset.jpg",
      albumId: "vacation",
      createdAt: 1700000000
    })
    expect(photo.id).toBe(PhotoId.make(1))
    expect(photo.createdAt).toBe(CreatedAtMillis.make(1700000000))
    const idFromParam = Schema.decodeSync(PhotoIdFromString)("42")
    expect(idFromParam).toBe(PhotoId.make(42))
  })

  it("constructs PhotoNotFoundError and AlbumQuotaExceededError with branded fields", () => {
    const notFound = new PhotoNotFoundError({ id: PhotoId.make(42) })
    expect(notFound._tag).toBe("PhotoNotFoundError")
    expect(notFound.id).toBe(42)

    const quota = new AlbumQuotaExceededError({
      albumId: AlbumId.make("vacation"),
      count: AlbumPhotoCount.make(100)
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

  it("scripts/check-openapi.mjs CLI exits with code 2 and ESCALATE on breaking change", () => {
    const liveSpec = buildOpenApiSpec() as any
    const baselineSpec = JSON.parse(JSON.stringify(liveSpec))
    if (baselineSpec.paths?.["/photos"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema?.items) {
      const items = baselineSpec.paths["/photos"].get.responses["200"].content["application/json"].schema.items
      items.required = [...(items.required ?? []), "extraRequiredField"]
      items.properties = { ...items.properties, extraRequiredField: { type: "string" } }
    }
    const tmpBaselineFile = resolve(
      os.tmpdir(),
      `test-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    )
    try {
      writeFileSync(tmpBaselineFile, JSON.stringify(baselineSpec, null, 2), "utf8")
      const res = spawnSync(
        process.execPath,
        ["--import", resolverPath, checkScriptPath, "--baseline", tmpBaselineFile],
        { encoding: "utf8" }
      )
      expect(res.status).toBe(2)
      expect(res.stderr).toContain("ESCALATE")
    } finally {
      rmSync(tmpBaselineFile, { force: true })
    }
  })

  describe("detectOpenApiBreakingChanges", () => {
    it("reports no breaking changes when baseline matches current", () => {
      const baseline = {
        paths: {
          "/photos": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id", "name"]
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      expect(detectOpenApiBreakingChanges(baseline, baseline)).toEqual([])
    })

    it("detects removed path", () => {
      const baseline = { paths: { "/photos": {}, "/albums": {} } }
      const current = { paths: { "/photos": {} } }
      const changes = detectOpenApiBreakingChanges(baseline, current)
      expect(changes).toContain("Removed path: /albums")
    })

    it("detects removed HTTP method", () => {
      const baseline = { paths: { "/photos": { get: {}, post: {} } } }
      const current = { paths: { "/photos": { get: {} } } }
      const changes = detectOpenApiBreakingChanges(baseline, current)
      expect(changes).toContain("Removed method: POST /photos")
    })

    it("detects removed required response schema property", () => {
      const baseline = {
        paths: {
          "/photos": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id", "name", "albumId"]
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      const current = {
        paths: {
          "/photos": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id", "name"]
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      const changes = detectOpenApiBreakingChanges(baseline, current)
      expect(changes.some((c) => c.includes("albumId"))).toBe(true)
    })
  })
})
