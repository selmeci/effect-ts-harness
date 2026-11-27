import { Effect } from "effect"
import { match } from "ts-pattern"
import { WORKFLOW_TIMEOUT_BUDGETS, type OllamaWarmupError } from "@harness/contract"
import {
  checkOllamaServerReadyDetailed as infraCheckOllamaServerReadyDetailed,
  OllamaEmbeddingClientLive,
  OllamaReadiness,
  type OllamaProbeResult,
  type OllamaWarmupOptions,
  type OllamaWarmupReceipt,
  type OllamaWarmupStateHandle,
} from "@harness/infra"

export {
  OllamaReadiness,
  type OllamaProbeResult,
  type OllamaWarmupReceipt,
  type OllamaWarmupStateHandle,
}

export interface OllamaReadinessOptions {
  readonly baseUrl?: string | undefined
  readonly spawnOllama?: (() => void) | undefined
  readonly maxRetries?: number | undefined
  readonly retryDelayMs?: number | undefined
  readonly probeBudgetMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
  readonly force?: boolean | undefined
  readonly clefModel?: string | undefined
  readonly embeddingModel?: string | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly state?: OllamaWarmupStateHandle | undefined
}

const toWarmupOptions = (opts?: OllamaReadinessOptions): OllamaWarmupOptions | undefined => {
  if (opts === undefined) {
    return undefined
  }
  const derivedBudgetMs =
    opts.probeBudgetMs !== undefined
      ? opts.probeBudgetMs
      : opts.maxRetries !== undefined || opts.retryDelayMs !== undefined
        ? opts.maxRetries === 0
          ? 1
          : Math.max(1, (opts.maxRetries ?? 25) * (opts.retryDelayMs ?? 200))
        : WORKFLOW_TIMEOUT_BUDGETS.ollamaWarmupProbeMs
  const pollIntervalMs = opts.pollIntervalMs ?? opts.retryDelayMs
  return {
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.clefModel !== undefined ? { clefModel: opts.clefModel } : {}),
    ...(opts.embeddingModel !== undefined ? { embeddingModel: opts.embeddingModel } : {}),
    probeBudgetMs: derivedBudgetMs,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.spawnOllama !== undefined ? { spawnOllama: opts.spawnOllama } : {}),
    ...(opts.state !== undefined ? { state: opts.state } : {}),
  }
}

export function checkOllamaServerReadyDetailed(
  baseUrl: string = process.env.HARNESS_OLLAMA_URL ??
    process.env.OLLAMA_HOST ??
    "http://127.0.0.1:11434",
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Effect.Effect<OllamaProbeResult> {
  return infraCheckOllamaServerReadyDetailed(baseUrl, fetchFn)
}

export function checkOllamaServerReady(
  baseUrl: string = process.env.HARNESS_OLLAMA_URL ??
    process.env.OLLAMA_HOST ??
    "http://127.0.0.1:11434",
): Effect.Effect<boolean> {
  return checkOllamaServerReadyDetailed(baseUrl).pipe(Effect.map((r) => r.ready))
}

export const ensureOllamaWarmWithResult = (
  opts?: OllamaReadinessOptions,
): Effect.Effect<OllamaWarmupReceipt, OllamaWarmupError> =>
  OllamaReadiness.ensureWarm(toWarmupOptions(opts)).pipe(Effect.provide(OllamaEmbeddingClientLive))

export function ensureLocalOllamaReady(opts?: OllamaReadinessOptions): Effect.Effect<boolean> {
  return Effect.result(ensureOllamaWarmWithResult(opts)).pipe(
    Effect.map((res) =>
      match(res)
        .with({ _tag: "Success" }, () => true)
        .with({ _tag: "Failure" }, ({ failure }) => {
          process.stderr.write(
            `[harness:ollama] ${failure.reason} (stage=${failure.stage}, model=${failure.model}, endpoint=${failure.endpoint})\n`,
          )
          return false
        })
        .exhaustive(),
    ),
  )
}
