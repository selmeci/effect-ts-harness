import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  AlbumQuotaExceededError,
  buildOpenApiSpec,
  CreatePhotoInput,
  detectOpenApiBreakingChanges,
  GreetInput,
  Photo,
  PhotoCounterRpc,
  PhotoNotFoundError,
  SampleApi
} from "../src/index.js"

const currentDir = import.meta.dirname ?? fileURLToPath(new URL(".", import.meta.url))
const repoRoot = resolve(currentDir, "../../../..")
const checkScriptPath = resolve(currentDir, "../scripts/check-openapi.mjs")
const resolverPath = resolve(repoRoot, "tools/node-ts-resolver.mjs")
const openApiPath = resolve(currentDir, "../openapi.json")

describe("sample-contract (Schemas, HttpApi, RpcGroup, OpenAPI)", () => {
  it("preserves GreetInput for backward compatibility", () => {
    const decoded = Schema.decodeSync(GreetInput)({ name: "Roman" })
    expect(decoded.name).toBe("Roman")
  })

  it("decodes Photo and CreatePhotoInput Schemas", () => {
    const input = Schema.decodeSync(CreatePhotoInput)({ name: "sunset.jpg", albumId: "vacation" })
    expect(input.albumId).toBe("vacation")
    const photo = Schema.decodeSync(Photo)({
      id: 1,
      name: "sunset.jpg",
      albumId: "vacation",
      createdAt: 1700000000
    })
    expect(photo.id).toBe(1)
  })

  it("constructs PhotoNotFoundError and AlbumQuotaExceededError", () => {
    const notFound = new PhotoNotFoundError({ id: 42 })
    expect(notFound._tag).toBe("PhotoNotFoundError")
    expect(notFound.id).toBe(42)

    const quota = new AlbumQuotaExceededError({ albumId: "vacation", count: 100 })
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
    interface OpenApiDoc {
      paths?: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              {
                content?: Record<
                  string,
                  {
                    schema?: {
                      items?: {
                        required?: string[]
                        properties?: Record<string, unknown>
                      }
                    }
                  }
                >
              }
            >
          }
        >
      >
    }
    const liveSpec = buildOpenApiSpec()
    const baselineSpec: OpenApiDoc = JSON.parse(JSON.stringify(liveSpec))
    const items =
      baselineSpec.paths?.["/photos"]?.["get"]?.responses?.["200"]?.content?.["application/json"]?.schema?.items
    if (items) {
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
