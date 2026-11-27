import { Cause, Clock, Deferred, Effect, Exit, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  EmbeddingSourceText,
  OllamaWarmupError,
  OllamaWarmupStage,
  WORKFLOW_TIMEOUT_BUDGETS,
  toErrorReasonMessage,
} from "@harness/contract"
import { EmbeddingClient } from "@harness/service"
import type { SyncHostSpawnDetachedResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"
import {
  DEFAULT_CLEF_MODEL,
  DEFAULT_MAX_INTERRUPT_RETRIES,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  OllamaTagsResponseSchema,
  TAGS_PROBE_TIMEOUT_MS,
  buildSanitizedOllamaServeEnv,
  makeWarmupError,
  resolveConfiguredBaseUrl,
  toWorkflowTimeoutMs,
  validateLoopbackBaseUrl,
} from "./ollama-readiness-helpers.js"
import { isPureInterruptCause } from "@harness/contract"

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

export interface OllamaWarmupOutcomeSuccess {
  readonly _tag: "Success"
  readonly receipt: OllamaWarmupReceipt
}

export interface OllamaWarmupOutcomeFailure {
  readonly _tag: "Failure"
  readonly error: OllamaWarmupError
}

export interface OllamaWarmupOutcomeInterrupted {
  readonly _tag: "Interrupted"
}

export type OllamaWarmupOutcome =
  | OllamaWarmupOutcomeSuccess
  | OllamaWarmupOutcomeFailure
  | OllamaWarmupOutcomeInterrupted

export interface OllamaWarmupStateHandle {
  readonly _tag: "OllamaWarmupStateHandle"
  readonly getWarmEntry: (key: string) => OllamaWarmupReceipt | undefined
  readonly setWarmEntry: (key: string, receipt: OllamaWarmupReceipt) => void
  readonly getInFlight: (key: string) => Deferred.Deferred<OllamaWarmupOutcome, never> | undefined
  readonly setInFlight: (
    key: string,
    deferred: Deferred.Deferred<OllamaWarmupOutcome, never>,
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
  const inFlight = new Map<string, Deferred.Deferred<OllamaWarmupOutcome, never>>()
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
    baseUrl?: string,
    fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ): Effect.fn.Return<OllamaProbeResult> {
    const resolvedBaseUrl =
      baseUrl !== undefined && baseUrl.trim().length > 0 ? baseUrl : resolveConfiguredBaseUrl()
    return yield* match(validateLoopbackBaseUrl(resolvedBaseUrl))
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
                    const timedJson = yield* Effect.result(
                      Effect.tryPromise({
                        try: () => response.json(),
                        catch: (err) =>
                          `Ollama ${targetUrl} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
                      }).pipe(Effect.onInterrupt(() => cancelResponseBodyQuietly(response))),
                    ).pipe(Effect.timeoutOption(`${TAGS_PROBE_TIMEOUT_MS} millis`))
                    return yield* match(timedJson)
                      .with({ _tag: "None" }, () =>
                        cancelResponseBodyQuietly(response).pipe(
                          Effect.as({
                            ready: false,
                            reason: `Ollama ${targetUrl} body read timed out after ${TAGS_PROBE_TIMEOUT_MS}ms`,
                          } satisfies OllamaProbeResult),
                        ),
                      )
                      .with(
                        { _tag: "Some", value: { _tag: "Failure" } },
                        ({ value: { failure } }) =>
                          Effect.succeed({
                            ready: false,
                            reason: failure,
                          } satisfies OllamaProbeResult),
                      )
                      .with(
                        { _tag: "Some", value: { _tag: "Success" } },
                        ({ value: { success: rawJson } }) =>
                          Effect.succeed(
                            match(Schema.decodeUnknownOption(OllamaTagsResponseSchema)(rawJson))
                              .with({ _tag: "None" }, () => ({
                                ready: false,
                                reason: `Ollama ${targetUrl} response missing models array`,
                              }))
                              .with({ _tag: "Some" }, ({ value: body }) => {
                                const hasClef = body.models.some(
                                  (m) =>
                                    m.name.startsWith(DEFAULT_CLEF_MODEL) ||
                                    (m.model !== undefined &&
                                      m.model.startsWith(DEFAULT_CLEF_MODEL)),
                                )
                                return hasClef
                                  ? ({ ready: true } satisfies OllamaProbeResult)
                                  : ({
                                      ready: false,
                                      reason: `Ollama ${targetUrl} has no ${DEFAULT_CLEF_MODEL} model loaded`,
                                    } satisfies OllamaProbeResult)
                              })
                              .exhaustive(),
                          ),
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
                  type: "noul",
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

  const spawnResult = nodeSyncHostIo.spawnDetached("ollama", ["serve"], {
    env: buildSanitizedOllamaServeEnv(),
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

  const exitToOutcome = (
    exit: Exit.Exit<OllamaWarmupReceipt, OllamaWarmupError>,
  ): OllamaWarmupOutcome =>
    Exit.match(exit, {
      onSuccess: (receipt) => ({ _tag: "Success" as const, receipt }),
      onFailure: (cause) =>
        match(Cause.findErrorOption(cause))
          .with({ _tag: "Some" }, ({ value: error }) => ({ _tag: "Failure" as const, error }))
          .with({ _tag: "None" }, () =>
            isPureInterruptCause(cause)
              ? ({ _tag: "Interrupted" as const } satisfies OllamaWarmupOutcome)
              : ({
                  _tag: "Failure" as const,
                  error: makeWarmupError({
                    stage: OllamaWarmupStage.make("server-start"),
                    model: clefModel,
                    endpoint: tagsUrl,
                    timeoutMs: probeBudgetMs,
                    reason: Cause.squash(cause),
                    fallback: "Ollama warm-up failed unexpectedly",
                  }),
                } satisfies OllamaWarmupOutcome),
          )
          .exhaustive(),
    })

  const runAttempt = (
    remainingInterruptRetries: number,
  ): Effect.Effect<OllamaWarmupReceipt, OllamaWarmupError> =>
    Effect.uninterruptibleMask((restore) =>
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

        const activeFlight = options?.force === true ? undefined : state.getInFlight(cacheKey)
        if (activeFlight !== undefined) {
          const outcome = yield* restore(Deferred.await(activeFlight))
          return yield* match(outcome)
            .with({ _tag: "Success" }, ({ receipt }) =>
              Effect.succeed({
                warmedAtMs: receipt.warmedAtMs,
                clefWarm: receipt.clefWarm,
                embeddingsWarm: receipt.embeddingsWarm,
                cached: true,
              }),
            )
            .with({ _tag: "Failure" }, ({ error }) => Effect.fail(error))
            .with({ _tag: "Interrupted" }, () =>
              remainingInterruptRetries > 0
                ? restore(runAttempt(remainingInterruptRetries - 1))
                : Effect.fail(
                    makeWarmupError({
                      stage: OllamaWarmupStage.make("server-start"),
                      model: clefModel,
                      endpoint: tagsUrl,
                      timeoutMs: probeBudgetMs,
                      reason:
                        "Ollama warm-up interrupted repeatedly by concurrent caller cancellation",
                      fallback: "Ollama warm-up interrupted",
                    }),
                  ),
            )
            .exhaustive()
        }

        const deferred = yield* Deferred.make<OllamaWarmupOutcome, never>()
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
              if (state.getInFlight(cacheKey) === deferred) {
                state.deleteInFlight(cacheKey)
              }
            }).pipe(Effect.andThen(Effect.asVoid(Deferred.succeed(deferred, exitToOutcome(exit))))),
          ),
        )
      }),
    )

  return yield* runAttempt(DEFAULT_MAX_INTERRUPT_RETRIES)
})

export const OllamaReadiness = {
  ensureWarm: ensureOllamaWarm,
} as const
