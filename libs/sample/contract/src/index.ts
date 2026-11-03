import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Rpc, RpcGroup } from "effect/rpc"

// Branded Domain Value Schemas
export const PersonName = Schema.String.pipe(Schema.brand("PersonName"))
export type PersonName = typeof PersonName.Type

export const GreetingMessage = Schema.String.pipe(Schema.brand("GreetingMessage"))
export type GreetingMessage = typeof GreetingMessage.Type

export const PhotoId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("PhotoId"))
export type PhotoId = typeof PhotoId.Type

export const PhotoIdFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(PhotoId))
export type PhotoIdFromString = typeof PhotoIdFromString.Type

export const PhotoName = Schema.String.pipe(Schema.brand("PhotoName"))
export type PhotoName = typeof PhotoName.Type

export const AlbumId = Schema.String.pipe(Schema.brand("AlbumId"))
export type AlbumId = typeof AlbumId.Type

export const CreatedAtMillis = Schema.Int.pipe(Schema.brand("CreatedAtMillis"))
export type CreatedAtMillis = typeof CreatedAtMillis.Type

export const AlbumPhotoCount = Schema.Natural.pipe(Schema.brand("AlbumPhotoCount"))
export type AlbumPhotoCount = typeof AlbumPhotoCount.Type

// Backward-compatible GreetInput export for sample-domain
export const GreetInput = Schema.Struct({ name: PersonName })
export type GreetInput = typeof GreetInput.Type

export const DecideAlbumQuotaInput = Schema.Struct({
  albumId: AlbumId,
  currentCount: AlbumPhotoCount,
})
export type DecideAlbumQuotaInput = typeof DecideAlbumQuotaInput.Type

// Schemas
export const Photo = Schema.Struct({
  id: PhotoId,
  name: PhotoName,
  albumId: AlbumId,
  createdAt: CreatedAtMillis,
})
export type Photo = typeof Photo.Type

export const CreatePhotoInput = Schema.Struct({
  name: PhotoName,
  albumId: AlbumId,
})
export type CreatePhotoInput = typeof CreatePhotoInput.Type

// Tagged Errors
export class PhotoNotFoundError extends Schema.TaggedError<PhotoNotFoundError>()(
  "PhotoNotFoundError",
  { id: PhotoId },
) {}

export class AlbumQuotaExceededError extends Schema.TaggedError<AlbumQuotaExceededError>()(
  "AlbumQuotaExceededError",
  { albumId: AlbumId, count: AlbumPhotoCount },
) {}

// HttpApi Group & API
export const PhotosApiGroup = HttpApiGroup.make("photos").add(
  HttpApiEndpoint.get("listPhotos", "/photos", {
    success: Schema.Array(Photo),
  }),
  HttpApiEndpoint.post("createPhoto", "/photos", {
    payload: CreatePhotoInput,
    success: Photo,
    error: AlbumQuotaExceededError,
  }),
  HttpApiEndpoint.get("getPhoto", "/photos/:id", {
    params: Schema.Struct({ id: PhotoIdFromString }),
    success: Photo,
    error: PhotoNotFoundError,
  }),
)

export const SampleApi = HttpApi.make("SampleApi").add(PhotosApiGroup)
export type SampleApi = typeof SampleApi

export const buildOpenApiSpec = (): unknown => OpenApi.fromApi(SampleApi)

// RpcGroup
export const IncrementAlbumCount = Rpc.make("IncrementAlbumCount", {
  payload: Schema.Struct({ albumId: AlbumId }),
  success: AlbumPhotoCount,
  error: AlbumQuotaExceededError,
})
export type IncrementAlbumCount = typeof IncrementAlbumCount

export const GetAlbumCount = Rpc.make("GetAlbumCount", {
  payload: Schema.Struct({ albumId: AlbumId }),
  success: AlbumPhotoCount,
})
export type GetAlbumCount = typeof GetAlbumCount

export const PhotoCounterRpc = RpcGroup.make(IncrementAlbumCount, GetAlbumCount)
export type PhotoCounterRpc = typeof PhotoCounterRpc

// Pure Breaking Change Detector
const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head", "options", "trace"] as const

interface OpenApiSchemaNode {
  readonly type?: string
  readonly required?: readonly string[]
  readonly properties?: Record<string, unknown>
  readonly items?: OpenApiSchemaNode
}

interface OpenApiResponseNode {
  readonly content?: {
    readonly [mediaType: string]: {
      readonly schema?: OpenApiSchemaNode
    }
  }
}

interface OpenApiMethodNode {
  readonly responses?: Record<string, OpenApiResponseNode>
}

interface OpenApiPathsNode {
  readonly [path: string]: {
    readonly [method: string]: OpenApiMethodNode | undefined
  }
}

interface OpenApiDocument {
  readonly paths?: OpenApiPathsNode
  readonly components?: {
    readonly schemas?: Record<string, OpenApiSchemaNode>
  }
}

const checkSchemaProperties = (
  location: string,
  baseline: OpenApiSchemaNode | undefined,
  current: OpenApiSchemaNode | undefined,
): ReadonlyArray<string> => {
  if (baseline == null) {
    return []
  }
  const issues: string[] = []

  if (Array.isArray(baseline.required)) {
    const currentRequired = Array.isArray(current?.required) ? current.required : []
    for (const reqProp of baseline.required) {
      if (!currentRequired.includes(reqProp)) {
        issues.push(`Removed required property from ${location}: ${reqProp}`)
      }
    }
  }

  if (baseline.properties != null && typeof baseline.properties === "object") {
    const currentProps =
      current?.properties != null && typeof current.properties === "object"
        ? current.properties
        : {}
    for (const prop of Object.keys(baseline.properties)) {
      if (!(prop in currentProps)) {
        issues.push(`Removed property from ${location}: ${prop}`)
      }
    }
  }

  if (baseline.items != null && typeof baseline.items === "object") {
    const currentItems =
      current?.items != null && typeof current.items === "object" ? current.items : undefined
    issues.push(...checkSchemaProperties(`${location} items`, baseline.items, currentItems))
  }

  return issues
}

export const detectOpenApiBreakingChanges = (
  baselineSpec: unknown,
  currentSpec: unknown,
): ReadonlyArray<string> => {
  if (
    baselineSpec == null ||
    typeof baselineSpec !== "object" ||
    currentSpec == null ||
    typeof currentSpec !== "object"
  ) {
    return []
  }

  const baseline = baselineSpec as OpenApiDocument
  const current = currentSpec as OpenApiDocument
  const changes: string[] = []

  const baselinePaths = baseline.paths ?? {}
  const currentPaths = current.paths ?? {}

  for (const path of Object.keys(baselinePaths)) {
    if (!(path in currentPaths)) {
      changes.push(`Removed path: ${path}`)
      continue
    }

    const baselineMethods = baselinePaths[path] ?? {}
    const currentMethods = currentPaths[path] ?? {}

    for (const method of HTTP_METHODS) {
      if (method in baselineMethods) {
        if (!(method in currentMethods)) {
          changes.push(`Removed method: ${method.toUpperCase()} ${path}`)
          continue
        }

        const baselineMethodNode = baselineMethods[method] as OpenApiMethodNode | undefined
        const currentMethodNode = currentMethods[method] as OpenApiMethodNode | undefined

        const baselineResponses = baselineMethodNode?.responses ?? {}
        const currentResponses = currentMethodNode?.responses ?? {}

        for (const [status, baselineResponse] of Object.entries(baselineResponses)) {
          const currentResponse = currentResponses[status]
          if (currentResponse == null) {
            changes.push(`Removed response status ${status} from ${method.toUpperCase()} ${path}`)
            continue
          }

          const baselineSchema = baselineResponse.content?.["application/json"]?.schema
          const currentSchema = currentResponse.content?.["application/json"]?.schema

          changes.push(
            ...checkSchemaProperties(
              `${method.toUpperCase()} ${path} ${status}`,
              baselineSchema,
              currentSchema,
            ),
          )
        }
      }
    }
  }

  // Check components.schemas if present
  const baselineComponents = baseline.components?.schemas ?? {}
  const currentComponents = current.components?.schemas ?? {}
  for (const [schemaName, baselineComponentSchema] of Object.entries(baselineComponents)) {
    const currentComponentSchema = currentComponents[schemaName]
    if (currentComponentSchema == null) {
      changes.push(`Removed schema: ${schemaName}`)
      continue
    }
    changes.push(
      ...checkSchemaProperties(
        `schema ${schemaName}`,
        baselineComponentSchema,
        currentComponentSchema,
      ),
    )
  }

  return changes
}
