import { Clock, Deferred, Effect, Schema } from "effect"
import { match } from "ts-pattern"
import {
  DEFAULT_MAX_INTERRUPT_RETRIES,
  EmbeddingSourceText,
  OllamaWarmupError,
  OllamaWarmupStage,
  WORKFLOW_TIMEOUT_BUDGETS,
} from "@harness/contract"
import { EmbeddingClient } from "@harness/service"
import {
  DEFAULT_CLEF_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  OllamaTagsResponseSchema,
  TAGS_PROBE_TIMEOUT_MS,
  buildWarmupCacheKey,
  cancelResponseBodyQuietly,
  createOllamaWarmupState,
  exitToWarmupOutcome,
  isWarmReceiptFresh,
  makeWarmupError,
  probeSystemOneReady,
  probeTagsServerReachable,
  resolveConfiguredBaseUrl,
  spawnDetachedOllamaServer,
  toWorkflowTimeoutMs,
  validateLoopbackBaseUrl,
  type OllamaProbeNotReady,
  type OllamaProbeReady,
  type OllamaProbeResult,
  type OllamaWarmupOptions,
  type OllamaWarmupOutcome,
  type OllamaWarmupOutcomeFailure,
  type OllamaWarmupOutcomeInterrupted,
  type OllamaWarmupOutcomeSuccess,
  type OllamaWarmupReceipt,
  type OllamaWarmupStateHandle,
} from "./ollama-readiness-helpers.js"

export { createOllamaWarmupState }
export type {
  OllamaProbeNotReady,
  OllamaProbeReady,
  OllamaProbeResult,
  OllamaWarmupOptions,
  OllamaWarmupOutcome,
  OllamaWarmupOutcomeFailure,
  OllamaWarmupOutcomeInterrupted,
  OllamaWarmupOutcomeSuccess,
  OllamaWarmupReceipt,
  OllamaWarmupStateHandle,
}

const DEFAULT_OLLAMA_WARMUP_STATE: OllamaWarmupStateHandle = createOllamaWarmupState()

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

/**
 * Ensures local Ollama (`ollama serve` with `OLLAMA_KEEP_ALIVE=-1` guaranteed only for
 * processes spawned by `OllamaReadiness.ensureWarm`; externally started servers keep their own
 * environment), `clef-flash` via `POST /v1/systemone`, and `@harness/service/EmbeddingClient`
 * (when `includeEmbeddings !== false`) are warm and resident, coalescing concurrent callers via
 * single-flight `Deferred` and caching process-local warm state (`SPEC-0037 REQ-2.1`, `REQ-2.2`, `REQ-2.3`).
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
  const includeEmbeddings = options?.includeEmbeddings ?? true
  const fetchFn = options?.fetch ?? globalThis.fetch
  const state = options?.state ?? DEFAULT_OLLAMA_WARMUP_STATE

  const probeBudgetMs = yield* match(
    toWorkflowTimeoutMs(options?.probeBudgetMs ?? WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs),
  )
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        makeWarmupError({
          stage: OllamaWarmupStage.make("server-start"),
          model: clefModel,
          endpoint: rawBaseUrl,
          timeoutMs: WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs,
          reason: failure,
          fallback: "Invalid Ollama probeBudgetMs",
        }),
      ),
    )
    .exhaustive()

  const pollIntervalMs = yield* match(
    toWorkflowTimeoutMs(options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  )
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        makeWarmupError({
          stage: OllamaWarmupStage.make("server-start"),
          model: clefModel,
          endpoint: rawBaseUrl,
          timeoutMs: probeBudgetMs,
          reason: failure,
          fallback: "Invalid Ollama pollIntervalMs",
        }),
      ),
    )
    .exhaustive()

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
  const cacheKey = buildWarmupCacheKey(origin, clefModel, embeddingModel, includeEmbeddings)

  if (options?.force !== true) {
    const existingWarm = state.getWarmEntry(cacheKey)
    if (existingWarm !== undefined) {
      const nowMs = yield* Clock.currentTimeMillis
      if (isWarmReceiptFresh(existingWarm, nowMs, options?.warmCacheTtlMs)) {
        return {
          warmedAtMs: existingWarm.warmedAtMs,
          clefWarm: existingWarm.clefWarm,
          embeddingsWarm: existingWarm.embeddingsWarm,
          cached: true,
        }
      }
    }
  }

  const runAttempt = (
    remainingInterruptRetries: number,
  ): Effect.Effect<OllamaWarmupReceipt, OllamaWarmupError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (options?.force !== true) {
          const doubleCheckedWarm = state.getWarmEntry(cacheKey)
          if (doubleCheckedWarm !== undefined) {
            const nowMs = yield* Clock.currentTimeMillis
            if (isWarmReceiptFresh(doubleCheckedWarm, nowMs, options?.warmCacheTtlMs)) {
              return {
                warmedAtMs: doubleCheckedWarm.warmedAtMs,
                clefWarm: doubleCheckedWarm.clefWarm,
                embeddingsWarm: doubleCheckedWarm.embeddingsWarm,
                cached: true,
              }
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
        const startGen = state.getGeneration()
        state.setInFlight(cacheKey, deferred)

        const runWarmup = Effect.gen(function* () {
          const startedAtMs = yield* Clock.currentTimeMillis
          const remainingBudget = (): Effect.Effect<number> =>
            Clock.currentTimeMillis.pipe(
              Effect.map((nowMs) => Math.max(0, probeBudgetMs - (nowMs - startedAtMs))),
            )

          const initialReachable = yield* probeTagsServerReachable(tagsUrl, fetchFn, probeBudgetMs)
          yield* match(initialReachable)
            .with({ _tag: "Reachable" }, () => Effect.void)
            .with({ _tag: "HttpError" }, ({ status, body }) =>
              Effect.fail(
                makeWarmupError({
                  stage: OllamaWarmupStage.make("server-start"),
                  model: clefModel,
                  endpoint: tagsUrl,
                  timeoutMs: probeBudgetMs,
                  reason: `Ollama ${tagsUrl} returned HTTP ${status}${body.length > 0 ? `: ${body}` : ""}`,
                  fallback: `Ollama ${tagsUrl} returned HTTP ${status}`,
                }),
              ),
            )
            .with({ _tag: "Unreachable" }, ({ reason: initialReason }) =>
              Effect.gen(function* () {
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
                  yield* match(probeRes)
                    .with({ _tag: "Reachable" }, () =>
                      Effect.sync(() => {
                        serverReady = true
                      }),
                    )
                    .with({ _tag: "HttpError" }, ({ status, body }) =>
                      Effect.fail(
                        makeWarmupError({
                          stage: OllamaWarmupStage.make("server-start"),
                          model: clefModel,
                          endpoint: tagsUrl,
                          timeoutMs: probeBudgetMs,
                          reason: `Ollama ${tagsUrl} returned HTTP ${status}${body.length > 0 ? `: ${body}` : ""}`,
                          fallback: `Ollama ${tagsUrl} returned HTTP ${status}`,
                        }),
                      ),
                    )
                    .with({ _tag: "Unreachable" }, ({ reason }) =>
                      Effect.sync(() => {
                        lastReason = reason
                      }),
                    )
                    .exhaustive()
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
              }),
            )
            .exhaustive()

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

          if (includeEmbeddings) {
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
              .with({ _tag: "Some", value: { _tag: "Ok" } }, ({ value: { vectors } }) =>
                vectors.length === 1 && (vectors[0]?.components.length ?? 0) > 0
                  ? Effect.void
                  : Effect.fail(
                      makeWarmupError({
                        stage: OllamaWarmupStage.make("embeddings-probe"),
                        model: embeddingModel,
                        endpoint: embeddingsEndpoint,
                        timeoutMs: probeBudgetMs,
                        reason: `Embedding warm-up returned invalid/empty embedding vector count (vectors=${vectors.length}, components=${vectors[0]?.components.length ?? 0})`,
                        fallback: "Embedding warm-up returned empty vectors",
                      }),
                    ),
              )
              .exhaustive()
          }

          const warmedAtMs = yield* Clock.currentTimeMillis
          const receipt: OllamaWarmupReceipt = {
            warmedAtMs,
            clefWarm: true,
            embeddingsWarm: includeEmbeddings,
            cached: false,
          }
          if (state.getGeneration() === startGen) {
            state.setWarmEntry(cacheKey, receipt)
          }
          return receipt
        })

        return yield* restore(runWarmup).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (state.getGeneration() === startGen && state.getInFlight(cacheKey) === deferred) {
                state.deleteInFlight(cacheKey)
              }
            }).pipe(
              Effect.andThen(
                Effect.asVoid(
                  Deferred.succeed(
                    deferred,
                    exitToWarmupOutcome({ exit, clefModel, tagsUrl, probeBudgetMs }),
                  ),
                ),
              ),
            ),
          ),
        )
      }),
    )

  return yield* runAttempt(DEFAULT_MAX_INTERRUPT_RETRIES)
})

export const OllamaReadiness = {
  ensureWarm: ensureOllamaWarm,
} as const
