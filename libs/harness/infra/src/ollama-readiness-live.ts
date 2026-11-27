import { Clock, Deferred, Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  EmbeddingSourceText,
  OllamaEndpointUrl,
  OllamaModelName,
  OllamaWarmupError,
  OllamaWarmupStage,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowTimeoutMs,
  toErrorReasonMessage,
} from "@harness/contract"
import { EmbeddingClient } from "@harness/service"
import type { SyncHostSpawnDetachedResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
const DEFAULT_CLEF_MODEL = "clef-flash"
const DEFAULT_POLL_INTERVAL_MS = 200
const TAGS_PROBE_TIMEOUT_MS = 2_000
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

const OllamaTagsResponseSchema = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      model: Schema.optional(Schema.String),
    }),
  ),
})

export interface OllamaProbeReady {
  readonly ready: true
}

export interface OllamaProbeNotReady {
  readonly ready: false
  readonly reason: string
}

export type OllamaProbeResult = OllamaProbeReady | OllamaProbeNotReady

export interface OllamaWarmupReceipt {
  readonly warmedAtMs: number
  readonly clefWarm: boolean
  readonly embeddingsWarm: boolean
  readonly cached: boolean
}

export interface OllamaWarmupStateHandle {
  readonly _tag: "OllamaWarmupStateHandle"
  readonly getWarmEntry: (key: string) => OllamaWarmupReceipt | undefined
  readonly setWarmEntry: (key: string, receipt: OllamaWarmupReceipt) => void
  readonly getInFlight: (
    key: string,
  ) => Deferred.Deferred<OllamaWarmupReceipt, OllamaWarmupError> | undefined
  readonly setInFlight: (
    key: string,
    deferred: Deferred.Deferred<OllamaWarmupReceipt, OllamaWarmupError>,
  ) => void
  readonly deleteInFlight: (key: string) => void
  readonly clear: () => void
}

export interface OllamaWarmupOptions {
  readonly baseUrl?: string | undefined
  readonly clefModel?: string | undefined
  readonly embeddingModel?: string | undefined
  readonly probeBudgetMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
  readonly force?: boolean | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly spawnOllama?: (() => SyncHostSpawnDetachedResult | void) | undefined
  readonly state?: OllamaWarmupStateHandle | undefined
}

/** Creates an isolated process-local warm-state and single-flight coordinator for `OllamaReadiness.ensureWarm`. */
const createOllamaWarmupState = (): OllamaWarmupStateHandle => {
  const warmEntries = new Map<string, OllamaWarmupReceipt>()
  const inFlight = new Map<string, Deferred.Deferred<OllamaWarmupReceipt, OllamaWarmupError>>()
  return {
    _tag: "OllamaWarmupStateHandle",
    getWarmEntry: (key) => warmEntries.get(key),
    setWarmEntry: (key, receipt) => {
      warmEntries.set(key, receipt)
    },
    getInFlight: (key) => inFlight.get(key),
    setInFlight: (key, deferred) => {
      inFlight.set(key, deferred)
    },
    deleteInFlight: (key) => {
      inFlight.delete(key)
    },
    clear: () => {
      warmEntries.clear()
      inFlight.clear()
    },
  }
}

export { createOllamaWarmupState }

const DEFAULT_OLLAMA_WARMUP_STATE: OllamaWarmupStateHandle = createOllamaWarmupState()

const normalizeBaseUrlInput = (rawUrl: string): string => {
  const trimmed = rawUrl.trim().replace(/\/+$/, "")
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

const validateLoopbackBaseUrl = (rawUrl: string): Result.Result<URL, string> => {
  const urlRes = Result.try({
    try: () => new URL(normalizeBaseUrlInput(rawUrl)),
    catch: (cause) => toErrorReasonMessage(cause, "Invalid Ollama base URL"),
  })
  return match(urlRes)
    .with({ _tag: "Failure" }, ({ failure }) => Result.fail(failure))
    .with({ _tag: "Success" }, ({ success: parsed }) => {
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return Result.fail(`Unsupported Ollama protocol '${parsed.protocol}'`)
      }
      if (parsed.username !== "" || parsed.password !== "") {
        return Result.fail("Ollama URL must not embed credentials")
      }
      if (parsed.search !== "" || parsed.hash !== "") {
        return Result.fail("Ollama URL must not include query parameters or fragments")
      }
      if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
        return Result.fail(`Refusing non-loopback Ollama host '${parsed.hostname}' (loopback only)`)
      }
      return Result.succeed(parsed)
    })
    .exhaustive()
}

const toOllamaModelName = (raw: string): OllamaModelName => {
  const trimmed = raw.trim().slice(0, 128)
  return OllamaModelName.make(trimmed.length > 0 ? trimmed : DEFAULT_CLEF_MODEL)
}

const toOllamaEndpointUrl = (raw: string): OllamaEndpointUrl => {
  const trimmed = raw.trim().slice(0, 512)
  return OllamaEndpointUrl.make(
    trimmed.length > 0 ? trimmed : `${DEFAULT_OLLAMA_BASE_URL}/api/tags`,
  )
}

const toWorkflowTimeoutMs = (ms: number): WorkflowTimeoutMs => {
  const bounded = Math.min(2_147_483_647, Math.max(1, Math.floor(ms)))
  return WorkflowTimeoutMs.make(bounded)
}

const makeWarmupError = (params: {
  readonly stage: OllamaWarmupStage
  readonly model: string
  readonly endpoint: string
  readonly timeoutMs: number
  readonly reason: unknown
  readonly fallback: string
}): OllamaWarmupError =>
  new OllamaWarmupError({
    stage: params.stage,
    model: toOllamaModelName(params.model),
    endpoint: toOllamaEndpointUrl(params.endpoint),
    timeoutMs: toWorkflowTimeoutMs(params.timeoutMs),
    reason: toErrorReasonMessage(params.reason, params.fallback),
  })

const cancelResponseBodyQuietly = (response: Response): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => (response.body !== null ? response.body.cancel() : Promise.resolve()),
    catch: (cause) => toErrorReasonMessage(cause, "Failed to cancel Ollama response body"),
  }).pipe(Effect.catch((err) => Effect.logDebug("Failed to cancel Ollama response body", err)))

/**
 * Probes an Ollama loopback endpoint's `/api/tags` catalog and verifies whether `clef-flash`
 * is installed (`SPEC-0037 REQ-2.1`).
 */
export const checkOllamaServerReadyDetailed = Effect.fn("OllamaReadiness.checkServerReadyDetailed")(
  function* (
    baseUrl: string = process.env.HARNESS_OLLAMA_URL ??
      process.env.OLLAMA_HOST ??
      DEFAULT_OLLAMA_BASE_URL,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Effect.fn.Return<OllamaProbeResult> {
    return yield* match(validateLoopbackBaseUrl(baseUrl))
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.succeed({ ready: false, reason: failure } satisfies OllamaProbeResult),
      )
      .with({ _tag: "Success" }, ({ success: parsedUrl }) =>
        Effect.gen(function* () {
          const targetUrl = `${parsedUrl.origin}/api/tags`
          const fetchResult = yield* Effect.result(
            Effect.tryPromise({
              try: (signal) =>
                fetchFn(targetUrl, {
                  method: "GET",
                  redirect: "error",
                  signal: AbortSignal.any([signal, AbortSignal.timeout(TAGS_PROBE_TIMEOUT_MS)]),
                }),
              catch: (err) =>
                `Ollama ${targetUrl} probe failed: ${err instanceof Error ? err.message : String(err)}`,
            }),
          )

          return yield* match(fetchResult)
            .with({ _tag: "Failure" }, ({ failure }) =>
              Effect.succeed({ ready: false, reason: failure } satisfies OllamaProbeResult),
            )
            .with({ _tag: "Success" }, ({ success: response }) =>
              match(response.status)
                .with(200, () =>
                  Effect.gen(function* () {
                    const jsonRes = yield* Effect.result(
                      Effect.tryPromise({
                        try: () => response.json(),
                        catch: (err) =>
                          `Ollama ${targetUrl} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
                      }).pipe(Effect.onInterrupt(() => cancelResponseBodyQuietly(response))),
                    )
                    return match(jsonRes)
                      .with({ _tag: "Failure" }, ({ failure }) => ({
                        ready: false,
                        reason: failure,
                      }))
                      .with({ _tag: "Success" }, ({ success: rawJson }) =>
                        match(Schema.decodeUnknownOption(OllamaTagsResponseSchema)(rawJson))
                          .with({ _tag: "None" }, () => ({
                            ready: false,
                            reason: `Ollama ${targetUrl} response missing models array`,
                          }))
                          .with({ _tag: "Some" }, ({ value: body }) => {
                            const hasClef = body.models.some(
                              (m) =>
                                m.name.startsWith(DEFAULT_CLEF_MODEL) ||
                                (m.model !== undefined && m.model.startsWith(DEFAULT_CLEF_MODEL)),
                            )
                            return hasClef
                              ? ({ ready: true } satisfies OllamaProbeResult)
                              : ({
                                  ready: false,
                                  reason: `Ollama ${targetUrl} has no ${DEFAULT_CLEF_MODEL} model loaded`,
                                } satisfies OllamaProbeResult)
                          })
                          .exhaustive(),
                      )
                      .exhaustive()
                  }),
                )
                .otherwise((status) =>
                  cancelResponseBodyQuietly(response).pipe(
                    Effect.as({
                      ready: false,
                      reason: `Ollama ${targetUrl} returned HTTP ${status}`,
                    } satisfies OllamaProbeResult),
                  ),
                ),
            )
            .exhaustive()
        }),
      )
      .exhaustive()
  },
)

const probeTagsServerReachable = (
  tagsUrl: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Effect.Effect<Result.Result<void, string>> =>
  Effect.gen(function* () {
    const boundedTimeoutMs = Math.max(1, Math.min(TAGS_PROBE_TIMEOUT_MS, Math.floor(timeoutMs)))
    const timed = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) =>
          fetchFn(tagsUrl, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(boundedTimeoutMs)]),
          }),
        catch: (err) =>
          `Ollama ${tagsUrl} unreachable: ${toErrorReasonMessage(err, "Network error")}`,
      }),
    ).pipe(Effect.timeoutOption(`${boundedTimeoutMs} millis`))

    return yield* match(timed)
      .with({ _tag: "None" }, () =>
        Effect.succeed(
          Result.fail(`Ollama ${tagsUrl} probe timed out after ${boundedTimeoutMs}ms`),
        ),
      )
      .with({ _tag: "Some", value: { _tag: "Failure" } }, ({ value: { failure } }) =>
        Effect.succeed(Result.fail(failure)),
      )
      .with({ _tag: "Some", value: { _tag: "Success" } }, ({ value: { success: response } }) =>
        cancelResponseBodyQuietly(response).pipe(
          Effect.as(
            response.ok
              ? Result.succeed(undefined)
              : Result.fail(`Ollama ${tagsUrl} returned HTTP ${response.status}`),
          ),
        ),
      )
      .exhaustive()
  })

const probeSystemOneReady = (params: {
  readonly systemOneUrl: string
  readonly clefModel: string
  readonly fetchFn: typeof globalThis.fetch
  readonly remainingMs: number
  readonly totalBudgetMs: number
}): Effect.Effect<void, OllamaWarmupError> =>
  Effect.gen(function* () {
    const boundedMs = Math.max(1, Math.floor(params.remainingMs))
    const timed = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) =>
          params.fetchFn(params.systemOneUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: params.clefModel,
              state: { readiness: "warmup" },
              questions: {
                ready: {
                  type: "boolean",
                  instructions: "Is the decision model warm?",
                },
              },
            }),
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(boundedMs)]),
          }),
        catch: (err) =>
          makeWarmupError({
            stage: OllamaWarmupStage.make("systemone-probe"),
            model: params.clefModel,
            endpoint: params.systemOneUrl,
            timeoutMs: params.totalBudgetMs,
            reason: err,
            fallback: `Failed probing ${params.systemOneUrl}`,
          }),
      }),
    ).pipe(Effect.timeoutOption(`${boundedMs} millis`))

    return yield* match(timed)
      .with({ _tag: "None" }, () =>
        Effect.fail(
          makeWarmupError({
            stage: OllamaWarmupStage.make("systemone-probe"),
            model: params.clefModel,
            endpoint: params.systemOneUrl,
            timeoutMs: params.totalBudgetMs,
            reason: `SystemOne warm-up probe timed out after ${boundedMs}ms`,
            fallback: "SystemOne warm-up probe timed out",
          }),
        ),
      )
      .with({ _tag: "Some", value: { _tag: "Failure" } }, ({ value: { failure } }) =>
        Effect.fail(failure),
      )
      .with({ _tag: "Some", value: { _tag: "Success" } }, ({ value: { success: response } }) =>
        cancelResponseBodyQuietly(response).pipe(
          Effect.flatMap(() =>
            response.ok
              ? Effect.void
              : Effect.fail(
                  makeWarmupError({
                    stage: OllamaWarmupStage.make("systemone-probe"),
                    model: params.clefModel,
                    endpoint: params.systemOneUrl,
                    timeoutMs: params.totalBudgetMs,
                    reason: `POST ${params.systemOneUrl} returned HTTP ${response.status}`,
                    fallback: "SystemOne probe returned non-OK status",
                  }),
                ),
          ),
        ),
      )
      .exhaustive()
  })

const spawnDetachedOllamaServer = (params: {
  readonly spawnOllama: (() => SyncHostSpawnDetachedResult | void) | undefined
  readonly customUrl: string | undefined
  readonly clefModel: string
  readonly tagsUrl: string
  readonly probeBudgetMs: number
}): Effect.Effect<void, OllamaWarmupError> => {
  if (params.spawnOllama !== undefined) {
    const customRes = Result.try({
      try: () => params.spawnOllama?.(),
      catch: (err) => toErrorReasonMessage(err, "Custom spawnOllama callback failed"),
    })
    return match(customRes)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(
          makeWarmupError({
            stage: OllamaWarmupStage.make("server-start"),
            model: params.clefModel,
            endpoint: params.tagsUrl,
            timeoutMs: params.probeBudgetMs,
            reason: failure,
            fallback: "Failed spawning ollama serve",
          }),
        ),
      )
      .with({ _tag: "Success" }, ({ success }) =>
        success === undefined
          ? Effect.void
          : match(success)
              .with({ _tag: "Spawned" }, () => Effect.void)
              .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
                Effect.fail(
                  makeWarmupError({
                    stage: OllamaWarmupStage.make("server-start"),
                    model: params.clefModel,
                    endpoint: params.tagsUrl,
                    timeoutMs: params.probeBudgetMs,
                    reason: spawnError,
                    fallback: "Failed spawning ollama serve",
                  }),
                ),
              )
              .exhaustive(),
      )
      .exhaustive()
  }

  if (params.customUrl !== undefined) {
    return Effect.fail(
      makeWarmupError({
        stage: OllamaWarmupStage.make("server-start"),
        model: params.clefModel,
        endpoint: params.tagsUrl,
        timeoutMs: params.probeBudgetMs,
        reason: `Ollama at ${params.tagsUrl} is unreachable and custom HARNESS_OLLAMA_URL is configured`,
        fallback: "Ollama server unreachable",
      }),
    )
  }

  const spawnResult = nodeSyncHostIo.spawnDetached("ollama", ["serve"], {
    env: {
      ...process.env,
      OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE ?? "-1",
    },
  })
  return match(spawnResult)
    .with({ _tag: "Spawned" }, () => Effect.void)
    .with({ _tag: "SpawnFailed" }, ({ spawnError }) =>
      Effect.fail(
        makeWarmupError({
          stage: OllamaWarmupStage.make("server-start"),
          model: params.clefModel,
          endpoint: params.tagsUrl,
          timeoutMs: params.probeBudgetMs,
          reason: `Failed to spawn 'ollama serve': ${spawnError}`,
          fallback: "Failed to spawn ollama serve",
        }),
      ),
    )
    .exhaustive()
}

/**
 * Ensures local Ollama (`ollama serve` with `OLLAMA_KEEP_ALIVE=-1`), `clef-flash` via
 * `POST /v1/systemone`, and `@harness/service/EmbeddingClient` are warm and resident,
 * coalescing concurrent callers via single-flight `Deferred` and caching process-local warm
 * state (`SPEC-0037 REQ-2.1`, `REQ-2.2`, `REQ-2.3`).
 */
export const ensureOllamaWarm = Effect.fn("OllamaReadiness.ensureWarm")(function* (
  options?: OllamaWarmupOptions,
): Effect.fn.Return<OllamaWarmupReceipt, OllamaWarmupError, EmbeddingClient> {
  const embeddingClient = yield* EmbeddingClient

  const envCustomUrl = process.env.HARNESS_OLLAMA_URL?.trim() || undefined
  const rawBaseUrl =
    options?.baseUrl?.trim() ||
    envCustomUrl ||
    process.env.OLLAMA_HOST?.trim() ||
    DEFAULT_OLLAMA_BASE_URL
  const clefModel =
    options?.clefModel?.trim() || process.env.HARNESS_CLEF_MODEL?.trim() || DEFAULT_CLEF_MODEL
  const embeddingModel = options?.embeddingModel?.trim() || embeddingClient.config.model
  const probeBudgetMs = toWorkflowTimeoutMs(
    options?.probeBudgetMs ?? WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs,
  )
  const pollIntervalMs = Math.max(
    1,
    Math.floor(options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  )
  const fetchFn = options?.fetch ?? globalThis.fetch
  const state = options?.state ?? DEFAULT_OLLAMA_WARMUP_STATE

  const parsedUrl = yield* match(validateLoopbackBaseUrl(rawBaseUrl))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        makeWarmupError({
          stage: OllamaWarmupStage.make("server-start"),
          model: clefModel,
          endpoint: rawBaseUrl,
          timeoutMs: probeBudgetMs,
          reason: failure,
          fallback: "Invalid Ollama loopback URL",
        }),
      ),
    )
    .exhaustive()

  const origin = parsedUrl.origin
  const tagsUrl = `${origin}/api/tags`
  const systemOneUrl = `${origin}/v1/systemone`
  const embeddingsEndpoint = `${origin}/v1/embeddings`
  const cacheKey = `${origin}|${clefModel}|${embeddingModel}`

  if (options?.force !== true) {
    const existingWarm = state.getWarmEntry(cacheKey)
    if (existingWarm !== undefined) {
      return {
        warmedAtMs: existingWarm.warmedAtMs,
        clefWarm: existingWarm.clefWarm,
        embeddingsWarm: existingWarm.embeddingsWarm,
        cached: true,
      }
    }
  }

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (options?.force !== true) {
        const doubleCheckedWarm = state.getWarmEntry(cacheKey)
        if (doubleCheckedWarm !== undefined) {
          return {
            warmedAtMs: doubleCheckedWarm.warmedAtMs,
            clefWarm: doubleCheckedWarm.clefWarm,
            embeddingsWarm: doubleCheckedWarm.embeddingsWarm,
            cached: true,
          }
        }
      }

      const activeFlight = state.getInFlight(cacheKey)
      if (activeFlight !== undefined) {
        return yield* restore(Deferred.await(activeFlight)).pipe(
          Effect.map((receipt) => ({
            warmedAtMs: receipt.warmedAtMs,
            clefWarm: receipt.clefWarm,
            embeddingsWarm: receipt.embeddingsWarm,
            cached: true,
          })),
        )
      }

      const deferred = yield* Deferred.make<OllamaWarmupReceipt, OllamaWarmupError>()
      state.setInFlight(cacheKey, deferred)

      const runWarmup = Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis
        const remainingBudget = (): Effect.Effect<number> =>
          Clock.currentTimeMillis.pipe(
            Effect.map((nowMs) => Math.max(0, probeBudgetMs - (nowMs - startedAtMs))),
          )

        const initialReachable = yield* probeTagsServerReachable(tagsUrl, fetchFn, probeBudgetMs)
        const initialReason = match(initialReachable)
          .with({ _tag: "Success" }, () => undefined)
          .with({ _tag: "Failure" }, ({ failure }) => failure)
          .exhaustive()

        if (initialReason !== undefined) {
          yield* spawnDetachedOllamaServer({
            spawnOllama: options?.spawnOllama,
            customUrl: options?.baseUrl !== undefined ? undefined : envCustomUrl,
            clefModel,
            tagsUrl,
            probeBudgetMs,
          })

          let lastReason = initialReason
          let serverReady = false
          while (!serverReady) {
            const remMs = yield* remainingBudget()
            if (remMs <= 0) {
              break
            }
            const sleepMs = Math.min(pollIntervalMs, remMs)
            yield* Effect.sleep(`${sleepMs} millis`)
            const afterSleepRem = yield* remainingBudget()
            const probeRes = yield* probeTagsServerReachable(
              tagsUrl,
              fetchFn,
              Math.max(1, afterSleepRem),
            )
            const nextReason = match(probeRes)
              .with({ _tag: "Success" }, () => undefined)
              .with({ _tag: "Failure" }, ({ failure }) => failure)
              .exhaustive()
            if (nextReason === undefined) {
              serverReady = true
            } else {
              lastReason = nextReason
            }
          }

          if (!serverReady) {
            return yield* makeWarmupError({
              stage: OllamaWarmupStage.make("server-start"),
              model: clefModel,
              endpoint: tagsUrl,
              timeoutMs: probeBudgetMs,
              reason: lastReason,
              fallback: `Ollama server at ${tagsUrl} did not become reachable within ${probeBudgetMs}ms`,
            })
          }
        }

        const remBeforeSystemOne = yield* remainingBudget()
        if (remBeforeSystemOne <= 0) {
          return yield* makeWarmupError({
            stage: OllamaWarmupStage.make("systemone-probe"),
            model: clefModel,
            endpoint: systemOneUrl,
            timeoutMs: probeBudgetMs,
            reason: `Probe budget (${probeBudgetMs}ms) exhausted before /v1/systemone warm-up`,
            fallback: "SystemOne warm-up probe budget exhausted",
          })
        }

        yield* probeSystemOneReady({
          systemOneUrl,
          clefModel,
          fetchFn,
          remainingMs: remBeforeSystemOne,
          totalBudgetMs: probeBudgetMs,
        })

        const remBeforeEmbeddings = yield* remainingBudget()
        if (remBeforeEmbeddings <= 0) {
          return yield* makeWarmupError({
            stage: OllamaWarmupStage.make("embeddings-probe"),
            model: embeddingModel,
            endpoint: embeddingsEndpoint,
            timeoutMs: probeBudgetMs,
            reason: `Probe budget (${probeBudgetMs}ms) exhausted before embeddings warm-up`,
            fallback: "Embeddings warm-up probe budget exhausted",
          })
        }

        const embedOutcome = yield* embeddingClient
          .embedBatch([EmbeddingSourceText.make("warmup")])
          .pipe(
            Effect.map((vectors) => ({ _tag: "Ok" as const, vectors })),
            Effect.catch((err) => Effect.succeed({ _tag: "Err" as const, reason: err.reason })),
            Effect.timeoutOption(`${remBeforeEmbeddings} millis`),
          )

        yield* match(embedOutcome)
          .with({ _tag: "None" }, () =>
            Effect.fail(
              makeWarmupError({
                stage: OllamaWarmupStage.make("embeddings-probe"),
                model: embeddingModel,
                endpoint: embeddingsEndpoint,
                timeoutMs: probeBudgetMs,
                reason: `Embedding warm-up timed out after ${remBeforeEmbeddings}ms`,
                fallback: "Embedding warm-up timed out",
              }),
            ),
          )
          .with({ _tag: "Some", value: { _tag: "Err" } }, ({ value: { reason } }) =>
            Effect.fail(
              makeWarmupError({
                stage: OllamaWarmupStage.make("embeddings-probe"),
                model: embeddingModel,
                endpoint: embeddingsEndpoint,
                timeoutMs: probeBudgetMs,
                reason,
                fallback: "Embedding warm-up request failed",
              }),
            ),
          )
          .with({ _tag: "Some", value: { _tag: "Ok" } }, () => Effect.void)
          .exhaustive()

        const warmedAtMs = yield* Clock.currentTimeMillis
        const receipt: OllamaWarmupReceipt = {
          warmedAtMs,
          clefWarm: true,
          embeddingsWarm: true,
          cached: false,
        }
        state.setWarmEntry(cacheKey, receipt)
        return receipt
      })

      return yield* restore(runWarmup).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            state.deleteInFlight(cacheKey)
          }).pipe(Effect.andThen(Effect.asVoid(Deferred.done(deferred, exit)))),
        ),
      )
    }),
  )
})

export const OllamaReadiness = {
  ensureWarm: ensureOllamaWarm,
} as const
