import { Effect, Layer, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  DEFAULT_QWEN_EMBEDDING_DIMENSIONS,
  DEFAULT_QWEN_EMBEDDING_MODEL,
  EmbeddingComponent,
  EmbeddingDimensionCount,
  EmbeddingModelId,
  EmbeddingProviderBaseUrl,
  type EmbeddingProviderConfig,
  EmbeddingProviderError,
  EmbeddingSourceText,
  type EmbeddingVector,
  type KnowledgeQueryText,
  toErrorReasonMessage,
} from "@harness/contract"
import { EmbeddingClient } from "@harness/service"

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"
const AVAILABILITY_TIMEOUT_MS = 500
const EMBED_TIMEOUT_MS = 30_000
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

const EmbeddingsApiResponseSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      embedding: Schema.Array(Schema.Finite),
      index: Schema.optional(Schema.Finite),
    }),
  ),
})

const OllamaTagsResponseSchema = Schema.Struct({
  models: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        model: Schema.optional(Schema.String),
      }),
    ),
  ),
})

export interface OllamaEmbeddingClientOptions {
  readonly baseUrl?: EmbeddingProviderBaseUrl | undefined
  readonly model?: EmbeddingModelId | undefined
  readonly dimensions?: EmbeddingDimensionCount | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

const makeProviderError = (model: EmbeddingModelId, reason: string): EmbeddingProviderError =>
  new EmbeddingProviderError({
    model,
    reason: toErrorReasonMessage(reason, "Embedding provider request failed"),
  })

const validateLoopbackBaseUrl = (rawUrl: string): Result.Result<URL, string> => {
  const urlRes = Result.try({
    try: () => new URL(rawUrl.trim()),
    catch: (cause) => toErrorReasonMessage(cause, "Invalid embedding provider URL"),
  })
  return match(urlRes)
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, ({ success: parsed }) => {
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return Result.fail(`Unsupported embedding provider protocol '${parsed.protocol}'`)
      }
      if (parsed.username !== "" || parsed.password !== "") {
        return Result.fail("Embedding provider URL must not embed credentials")
      }
      if (parsed.search !== "" || parsed.hash !== "") {
        return Result.fail("Embedding provider URL must not include query parameters or fragments")
      }
      if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
        return Result.fail(
          `Refusing non-loopback embedding provider host '${parsed.hostname}' (loopback only)`,
        )
      }
      return Result.succeed(parsed)
    })
    .exhaustive()
}

const formatSafeEndpoint = (parsed: URL, suffix: string): string => {
  const cleanPath = parsed.pathname.replace(/\/+$/, "")
  return `${parsed.origin}${cleanPath}${suffix}`
}

const normalizeVector = (
  raw: ReadonlyArray<number>,
  expectedDimensions: number,
  model: EmbeddingModelId,
): Effect.Effect<EmbeddingVector, EmbeddingProviderError> => {
  if (raw.length !== expectedDimensions) {
    return Effect.fail(
      makeProviderError(
        model,
        `Dimension mismatch from embedding provider: expected ${expectedDimensions}, got ${raw.length}`,
      ),
    )
  }
  let sqSum = 0
  for (const val of raw) {
    if (!Number.isFinite(val)) {
      return Effect.fail(makeProviderError(model, "Embedding vector contains non-finite component"))
    }
    sqSum += val * val
  }
  const norm = Math.sqrt(sqSum)
  if (!Number.isFinite(norm) || norm <= 0) {
    return Effect.fail(makeProviderError(model, "Embedding vector has zero or non-finite L2 norm"))
  }
  return Effect.succeed({
    components: raw.map((val) => EmbeddingComponent.make(val / norm)),
  })
}

const matchesInstalledModel = (installedName: string, targetModel: string): boolean => {
  const normInstalled = installedName.trim()
  const normTarget = targetModel.trim()
  if (normInstalled === normTarget) return true
  if (normInstalled === `${normTarget}:latest` || `${normInstalled}:latest` === normTarget) {
    return true
  }
  return false
}

const cancelResponseBodyQuietly = (response: Response): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => (response.body !== null ? response.body.cancel() : Promise.resolve()),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

export const embedBatchViaOllama = Effect.fn("OllamaEmbeddingClient.embedBatch")(function* (
  texts: ReadonlyArray<EmbeddingSourceText>,
  config: EmbeddingProviderConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Effect.fn.Return<ReadonlyArray<EmbeddingVector>, EmbeddingProviderError, never> {
  if (texts.length === 0) {
    return []
  }

  const parsedBaseUrl = yield* match(validateLoopbackBaseUrl(config.baseUrl))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(makeProviderError(config.model, failure)),
    )
    .exhaustive()

  const endpoint = formatSafeEndpoint(parsedBaseUrl, "/embeddings")
  const response = yield* Effect.tryPromise({
    try: (fiberSignal) =>
      fetchFn(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model,
          input: [...texts],
        }),
        redirect: "error",
        signal: AbortSignal.any([fiberSignal, AbortSignal.timeout(EMBED_TIMEOUT_MS)]),
      }),
    catch: (cause) =>
      makeProviderError(
        config.model,
        `Failed calling ${endpoint}: ${toErrorReasonMessage(cause, "Network error")}`,
      ),
  })

  if (!response.ok) {
    yield* cancelResponseBodyQuietly(response)
    return yield* makeProviderError(
      config.model,
      `Embedding endpoint ${endpoint} returned HTTP ${response.status}`,
    )
  }

  const jsonPayload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) =>
      makeProviderError(
        config.model,
        `Invalid JSON from ${endpoint}: ${toErrorReasonMessage(cause, "Parse error")}`,
      ),
  }).pipe(Effect.onInterrupt(() => cancelResponseBodyQuietly(response)))

  const decoded = yield* Schema.decodeUnknownEffect(EmbeddingsApiResponseSchema)(jsonPayload).pipe(
    Effect.mapError((cause) =>
      makeProviderError(config.model, `Unexpected /v1/embeddings payload shape: ${String(cause)}`),
    ),
  )

  if (decoded.data.length !== texts.length) {
    return yield* makeProviderError(
      config.model,
      `Expected ${texts.length} embeddings from ${config.model}, got ${decoded.data.length}`,
    )
  }

  const ordered = [...decoded.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const normalized: Array<EmbeddingVector> = []
  for (const item of ordered) {
    normalized.push(yield* normalizeVector(item.embedding, config.dimensions, config.model))
  }
  return normalized
})

const formatQwen3InstructQuery = (query: KnowledgeQueryText): EmbeddingSourceText =>
  EmbeddingSourceText.make(
    `Instruct: Given a technical architecture, Effect-TS pattern, or EARS specification query, retrieve the most relevant documentation or requirement passage.\nQuery: ${query}`,
  )

const makeOllamaEmbeddingClientLayer = (
  options?: OllamaEmbeddingClientOptions,
): Layer.Layer<EmbeddingClient> =>
  Layer.effect(
    EmbeddingClient,
    Effect.sync(() => {
      const fetchFn = options?.fetch ?? globalThis.fetch
      const rawBaseUrl =
        options?.baseUrl ?? (process.env.HARNESS_EMBEDDING_BASE_URL?.trim() || DEFAULT_BASE_URL)
      const rawModel =
        options?.model ??
        (process.env.HARNESS_EMBEDDING_MODEL?.trim() || DEFAULT_QWEN_EMBEDDING_MODEL)
      const cfg: EmbeddingProviderConfig = {
        baseUrl: EmbeddingProviderBaseUrl.make(rawBaseUrl),
        model: EmbeddingModelId.make(rawModel),
        dimensions:
          options?.dimensions ?? EmbeddingDimensionCount.make(DEFAULT_QWEN_EMBEDDING_DIMENSIONS),
      }

      return EmbeddingClient.of({
        config: cfg,
        checkAvailability: Effect.gen(function* () {
          const baseUrlRes = validateLoopbackBaseUrl(cfg.baseUrl)
          const parsedUrl = match(baseUrlRes)
            .with({ _tag: "Success" }, ({ success }) => success)
            .with({ _tag: "Failure" }, () => undefined)
            .exhaustive()
          if (parsedUrl === undefined) {
            return "unavailable" as const
          }

          const tagsUrl = `${parsedUrl.origin}/api/tags`
          const responseOpt = yield* Effect.tryPromise({
            try: (fiberSignal) =>
              fetchFn(tagsUrl, {
                method: "GET",
                redirect: "error",
                signal: AbortSignal.any([
                  fiberSignal,
                  AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
                ]),
              }),
            catch: () => undefined,
          }).pipe(Effect.option)

          return yield* match(responseOpt)
            .with({ _tag: "None" }, () => Effect.succeed("unavailable" as const))
            .with({ _tag: "Some" }, ({ value: response }) =>
              Effect.gen(function* () {
                if (!response.ok) {
                  yield* cancelResponseBodyQuietly(response)
                  return "unavailable" as const
                }
                const jsonOpt = yield* Effect.tryPromise({
                  try: () => response.json(),
                  catch: () => undefined,
                }).pipe(
                  Effect.onInterrupt(() => cancelResponseBodyQuietly(response)),
                  Effect.option,
                )
                return match(jsonOpt)
                  .with({ _tag: "None" }, () => "unavailable" as const)
                  .with({ _tag: "Some" }, ({ value: rawJson }) =>
                    match(Schema.decodeUnknownOption(OllamaTagsResponseSchema)(rawJson))
                      .with({ _tag: "None" }, () => "unavailable" as const)
                      .with({ _tag: "Some" }, ({ value: parsed }) => {
                        const models = parsed.models ?? []
                        const hasModel = models.some(
                          (m) =>
                            matchesInstalledModel(m.name, cfg.model) ||
                            (m.model !== undefined && matchesInstalledModel(m.model, cfg.model)),
                        )
                        return hasModel ? ("available" as const) : ("unavailable" as const)
                      })
                      .exhaustive(),
                  )
                  .exhaustive()
              }),
            )
            .exhaustive()
        }),
        embedBatch: (texts) => embedBatchViaOllama(texts, cfg, fetchFn),
        embedQuery: (query) =>
          embedBatchViaOllama([formatQwen3InstructQuery(query)], cfg, fetchFn).pipe(
            Effect.flatMap((vectors) =>
              vectors[0] !== undefined
                ? Effect.succeed(vectors[0])
                : Effect.fail(makeProviderError(cfg.model, "Empty query embedding batch")),
            ),
          ),
      })
    }),
  )

export const OllamaEmbeddingClientLive: Layer.Layer<EmbeddingClient> =
  makeOllamaEmbeddingClientLayer()

export { makeOllamaEmbeddingClientLayer }
