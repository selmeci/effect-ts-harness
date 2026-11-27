import { Cause, Clock, Deferred, Effect, Exit, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  OllamaEndpointUrl,
  OllamaModelName,
  OllamaWarmupError,
  OllamaWarmupStage,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkflowTimeoutMs,
  isPureInterruptCause,
  toErrorReasonMessage,
} from "@harness/contract"
import type { SyncHostSpawnDetachedResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "./node-host-io.js"

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
export const DEFAULT_CLEF_MODEL = "clef-flash"
export const DEFAULT_POLL_INTERVAL_MS = 200
export const DEFAULT_WARM_CACHE_TTL_MS = 300_000
export const TAGS_PROBE_TIMEOUT_MS = 2_000
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

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
  readonly getGeneration: () => number
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
  readonly includeEmbeddings?: boolean | undefined
  readonly warmCacheTtlMs?: number | undefined
  readonly probeBudgetMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
  readonly force?: boolean | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly spawnOllama?: (() => SyncHostSpawnDetachedResult | void) | undefined
  readonly state?: OllamaWarmupStateHandle | undefined
}

export interface TagsReachabilityReachable {
  readonly _tag: "Reachable"
}

export interface TagsReachabilityUnreachable {
  readonly _tag: "Unreachable"
  readonly reason: string
}

export interface TagsReachabilityHttpError {
  readonly _tag: "HttpError"
  readonly status: number
  readonly body: string
}

export type TagsReachabilityResult =
  | TagsReachabilityReachable
  | TagsReachabilityUnreachable
  | TagsReachabilityHttpError

export const OllamaTagsResponseSchema = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      model: Schema.optional(Schema.String),
    }),
  ),
})

const SystemOneProbeJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** Creates an isolated process-local warm-state and single-flight coordinator for `OllamaReadiness.ensureWarm`. */
const createOllamaWarmupState = (): OllamaWarmupStateHandle => {
  let generation = 0
  const warmEntries = new Map<string, OllamaWarmupReceipt>()
  const inFlight = new Map<string, Deferred.Deferred<OllamaWarmupOutcome, never>>()
  return {
    _tag: "OllamaWarmupStateHandle",
    getGeneration: () => generation,
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
      generation += 1
      warmEntries.clear()
      inFlight.clear()
    },
  }
}

const resolveConfiguredBaseUrl = (): string =>
  process.env.HARNESS_OLLAMA_URL?.trim() ||
  process.env.OLLAMA_HOST?.trim() ||
  DEFAULT_OLLAMA_BASE_URL

const ALLOWED_OLLAMA_ENV_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "NVIDIA_VISIBLE_DEVICES",
  "HIP_VISIBLE_DEVICES",
])

const ALLOWED_OLLAMA_ENV_PREFIXES = ["XDG_", "LC_", "OLLAMA_", "CUDA_", "ROCR_", "HSA_"] as const

const buildSanitizedOllamaServeEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, val] of Object.entries(process.env)) {
    if (val === undefined) continue
    if (
      ALLOWED_OLLAMA_ENV_EXACT.has(key) ||
      ALLOWED_OLLAMA_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = val
    }
  }
  env.OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? "-1"
  return env
}

const normalizeBaseUrlInput = (rawUrl: string): string => {
  const trimmed = rawUrl.trim().replace(/\/+$/, "")
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
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

const toOllamaModelName = (raw: string, fallback: OllamaModelName): OllamaModelName => {
  const trimmed = raw.trim().slice(0, 128)
  return match(Schema.decodeOption(OllamaModelName)(trimmed))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => fallback)
    .exhaustive()
}

const toOllamaEndpointUrl = (raw: string, fallback: OllamaEndpointUrl): OllamaEndpointUrl => {
  const trimmed = raw.trim().slice(0, 512)
  return match(Schema.decodeOption(OllamaEndpointUrl)(trimmed))
    .with({ _tag: "Some" }, ({ value }) => value)
    .with({ _tag: "None" }, () => fallback)
    .exhaustive()
}

const toWorkflowTimeoutMs = (ms: number): Result.Result<WorkflowTimeoutMs, string> => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Result.fail(`Invalid positive finite timeoutMs '${ms}'`)
  }
  const bounded = Math.min(2_147_483_647, Math.max(1, Math.floor(ms)))
  return Result.succeed(WorkflowTimeoutMs.make(bounded))
}

const DEFAULT_FALLBACK_MODEL_NAME = OllamaModelName.make(DEFAULT_CLEF_MODEL)
const DEFAULT_FALLBACK_ENDPOINT_URL = OllamaEndpointUrl.make(`${DEFAULT_OLLAMA_BASE_URL}/api/tags`)

const makeWarmupError = (params: {
  readonly stage: OllamaWarmupStage
  readonly model: string
  readonly endpoint: string
  readonly timeoutMs: WorkflowTimeoutMs
  readonly reason: unknown
  readonly fallback: string
}): OllamaWarmupError =>
  new OllamaWarmupError({
    stage: params.stage,
    model: toOllamaModelName(params.model, DEFAULT_FALLBACK_MODEL_NAME),
    endpoint: toOllamaEndpointUrl(params.endpoint, DEFAULT_FALLBACK_ENDPOINT_URL),
    timeoutMs: params.timeoutMs,
    reason: toErrorReasonMessage(params.reason, params.fallback),
  })

const buildWarmupCacheKey = (
  origin: string,
  clefModel: string,
  embeddingModel: string,
  includeEmbeddings: boolean,
): string => `${origin}|${clefModel}|${includeEmbeddings ? embeddingModel : "no-embed"}`

const isWarmReceiptFresh = (
  receipt: OllamaWarmupReceipt,
  nowMs: number,
  warmCacheTtlMs: number | undefined,
): boolean => {
  const effectiveTtlMs = warmCacheTtlMs ?? DEFAULT_WARM_CACHE_TTL_MS
  return (
    Number.isFinite(effectiveTtlMs) &&
    effectiveTtlMs > 0 &&
    nowMs - receipt.warmedAtMs < effectiveTtlMs
  )
}

const validateSystemOneProbeBody = (
  bodyText: string,
  systemOneUrl: string,
): Result.Result<void, string> =>
  match(Schema.decodeOption(SystemOneProbeJsonSchema)(bodyText))
    .with({ _tag: "None" }, () =>
      Result.fail(`POST ${systemOneUrl} returned non-JSON or non-object response body`),
    )
    .with({ _tag: "Some" }, ({ value: record }) => {
      const errVal = record.error
      if (
        errVal !== undefined &&
        errVal !== null &&
        (typeof errVal !== "string" || errVal.trim().length > 0)
      ) {
        const detail = typeof errVal === "string" ? errVal.trim() : JSON.stringify(errVal)
        return Result.fail(`POST ${systemOneUrl} returned error payload: ${detail}`)
      }
      return Result.succeed(undefined)
    })
    .exhaustive()

const cancelResponseBodyQuietly = (response: Response): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => (response.body !== null ? response.body.cancel() : Promise.resolve()),
    catch: (cause) => toErrorReasonMessage(cause, "Failed to cancel Ollama response body"),
  }).pipe(Effect.catch((err) => Effect.logDebug("Failed to cancel Ollama response body", err)))

const readBoundedResponseBodySnippet = (
  response: Response,
  timeoutMs: number,
): Effect.Effect<string> => {
  const boundedMs = Math.max(1, Math.floor(timeoutMs))
  return Effect.result(
    Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => toErrorReasonMessage(cause, "Failed reading error body"),
    }).pipe(Effect.onInterrupt(() => cancelResponseBodyQuietly(response))),
  ).pipe(
    Effect.timeoutOption(`${boundedMs} millis`),
    Effect.flatMap((timed) =>
      match(timed)
        .with({ _tag: "None" }, () => cancelResponseBodyQuietly(response).pipe(Effect.as("")))
        .with({ _tag: "Some", value: { _tag: "Failure" } }, () => Effect.succeed(""))
        .with({ _tag: "Some", value: { _tag: "Success" } }, ({ value: { success } }) =>
          Effect.succeed(success.replace(/\s+/g, " ").trim().slice(0, 256)),
        )
        .exhaustive(),
    ),
  )
}

const probeTagsServerReachable = (
  tagsUrl: string,
  fetchFn: typeof globalThis.fetch,
  timeoutMs: number,
): Effect.Effect<TagsReachabilityResult> =>
  Effect.gen(function* () {
    const boundedTimeoutMs = Math.max(1, Math.min(TAGS_PROBE_TIMEOUT_MS, Math.floor(timeoutMs)))
    const probeStartMs = yield* Clock.currentTimeMillis
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
        Effect.succeed({
          _tag: "Unreachable",
          reason: `Ollama ${tagsUrl} probe timed out after ${boundedTimeoutMs}ms`,
        } satisfies TagsReachabilityResult),
      )
      .with({ _tag: "Some", value: { _tag: "Failure" } }, ({ value: { failure } }) =>
        Effect.succeed({ _tag: "Unreachable", reason: failure } satisfies TagsReachabilityResult),
      )
      .with({ _tag: "Some", value: { _tag: "Success" } }, ({ value: { success: response } }) =>
        response.ok
          ? cancelResponseBodyQuietly(response).pipe(
              Effect.as({ _tag: "Reachable" } satisfies TagsReachabilityResult),
            )
          : Effect.gen(function* () {
              const elapsedMs = (yield* Clock.currentTimeMillis) - probeStartMs
              const body = yield* readBoundedResponseBodySnippet(
                response,
                Math.max(1, boundedTimeoutMs - elapsedMs),
              )
              return {
                _tag: "HttpError",
                status: response.status,
                body,
              } satisfies TagsReachabilityResult
            }),
      )
      .exhaustive()
  })

const probeSystemOneReady = (params: {
  readonly systemOneUrl: string
  readonly clefModel: string
  readonly fetchFn: typeof globalThis.fetch
  readonly remainingMs: number
  readonly totalBudgetMs: typeof WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs
}): Effect.Effect<void, OllamaWarmupError> =>
  Effect.gen(function* () {
    const boundedMs = Math.max(1, Math.floor(params.remainingMs))
    const probeStartMs = yield* Clock.currentTimeMillis
    const makeStageError = (reason: unknown, fallback: string) =>
      makeWarmupError({
        stage: OllamaWarmupStage.make("systemone-probe"),
        model: params.clefModel,
        endpoint: params.systemOneUrl,
        timeoutMs: params.totalBudgetMs,
        reason,
        fallback,
      })

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
        catch: (err) => makeStageError(err, `Failed probing ${params.systemOneUrl}`),
      }),
    ).pipe(Effect.timeoutOption(`${boundedMs} millis`))

    return yield* match(timed)
      .with({ _tag: "None" }, () =>
        Effect.fail(
          makeStageError(
            `SystemOne warm-up probe timed out after ${boundedMs}ms`,
            "SystemOne warm-up probe timed out",
          ),
        ),
      )
      .with({ _tag: "Some", value: { _tag: "Failure" } }, ({ value: { failure } }) =>
        Effect.fail(failure),
      )
      .with({ _tag: "Some", value: { _tag: "Success" } }, ({ value: { success: response } }) =>
        response.ok
          ? Effect.gen(function* () {
              const elapsedMs = (yield* Clock.currentTimeMillis) - probeStartMs
              const bodyBudgetMs = Math.max(1, boundedMs - elapsedMs)
              const timedBody = yield* Effect.result(
                Effect.tryPromise({
                  try: () => response.text(),
                  catch: (err) =>
                    makeStageError(
                      `Failed reading ${params.systemOneUrl} response body: ${toErrorReasonMessage(err, "Body read error")}`,
                      "Failed reading SystemOne response body",
                    ),
                }).pipe(Effect.onInterrupt(() => cancelResponseBodyQuietly(response))),
              ).pipe(Effect.timeoutOption(`${bodyBudgetMs} millis`))

              return yield* match(timedBody)
                .with({ _tag: "None" }, () =>
                  cancelResponseBodyQuietly(response).pipe(
                    Effect.flatMap(() =>
                      Effect.fail(
                        makeStageError(
                          `SystemOne warm-up probe body read timed out after ${bodyBudgetMs}ms`,
                          "SystemOne warm-up probe body read timed out",
                        ),
                      ),
                    ),
                  ),
                )
                .with({ _tag: "Some", value: { _tag: "Failure" } }, ({ value: { failure } }) =>
                  Effect.fail(failure),
                )
                .with(
                  { _tag: "Some", value: { _tag: "Success" } },
                  ({ value: { success: bodyText } }) =>
                    match(validateSystemOneProbeBody(bodyText, params.systemOneUrl))
                      .with({ _tag: "Success" }, () => Effect.void)
                      .with({ _tag: "Failure" }, ({ failure }) =>
                        Effect.fail(
                          makeStageError(failure, "SystemOne probe returned invalid JSON"),
                        ),
                      )
                      .exhaustive(),
                )
                .exhaustive()
            })
          : cancelResponseBodyQuietly(response).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  makeStageError(
                    `POST ${params.systemOneUrl} returned HTTP ${response.status}`,
                    "SystemOne probe returned non-OK status",
                  ),
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
  readonly probeBudgetMs: typeof WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs
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

const exitToWarmupOutcome = (params: {
  readonly exit: Exit.Exit<OllamaWarmupReceipt, OllamaWarmupError>
  readonly clefModel: string
  readonly tagsUrl: string
  readonly probeBudgetMs: WorkflowTimeoutMs
}): OllamaWarmupOutcome =>
  Exit.match(params.exit, {
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
                  model: params.clefModel,
                  endpoint: params.tagsUrl,
                  timeoutMs: params.probeBudgetMs,
                  reason: Cause.squash(cause),
                  fallback: "Ollama warm-up failed unexpectedly",
                }),
              } satisfies OllamaWarmupOutcome),
        )
        .exhaustive(),
  })

export {
  buildSanitizedOllamaServeEnv,
  buildWarmupCacheKey,
  cancelResponseBodyQuietly,
  createOllamaWarmupState,
  exitToWarmupOutcome,
  isWarmReceiptFresh,
  makeWarmupError,
  probeSystemOneReady,
  probeTagsServerReachable,
  readBoundedResponseBodySnippet,
  resolveConfiguredBaseUrl,
  spawnDetachedOllamaServer,
  toOllamaEndpointUrl,
  toOllamaModelName,
  toWorkflowTimeoutMs,
  validateLoopbackBaseUrl,
  validateSystemOneProbeBody,
}
