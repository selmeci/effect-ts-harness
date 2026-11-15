import { Effect } from "effect"
import { match } from "ts-pattern"
import { nodeSyncHostIo } from "@harness/infra"

export interface OllamaReadinessOptions {
  readonly baseUrl?: string | undefined
  readonly spawnOllama?: (() => void) | undefined
  readonly maxRetries?: number | undefined
  readonly retryDelayMs?: number | undefined
}

export type OllamaProbeResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string }

export function checkOllamaServerReadyDetailed(
  baseUrl: string = process.env.HARNESS_OLLAMA_URL ??
    process.env.OLLAMA_HOST ??
    "http://127.0.0.1:11434",
): Effect.Effect<OllamaProbeResult> {
  const normalizedUrl = baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`
  const targetUrl = `${normalizedUrl.replace(/\/$/, "")}/api/tags`
  return Effect.tryPromise({
    try: () =>
      globalThis
        .fetch(targetUrl, {
          method: "GET",
          signal: AbortSignal.timeout(2000),
        })
        .then((r): Promise<OllamaProbeResult> =>
          match(r.status)
            .with(200, () =>
              r.json().then((rawBody: unknown): OllamaProbeResult => {
                if (typeof rawBody !== "object" || rawBody === null) {
                  return { ready: false, reason: `Ollama ${targetUrl} returned non-object JSON` }
                }
                const body = rawBody as {
                  readonly models?: ReadonlyArray<{
                    readonly name?: string
                    readonly model?: string
                  }>
                }
                if (!Array.isArray(body.models)) {
                  return { ready: false, reason: `Ollama ${targetUrl} response missing models array` }
                }
                const hasClef = body.models.some(
                  (m) =>
                    (typeof m.name === "string" && m.name.startsWith("clef-flash")) ||
                    (typeof m.model === "string" && m.model.startsWith("clef-flash")),
                )
                return hasClef
                  ? { ready: true }
                  : { ready: false, reason: `Ollama ${targetUrl} has no clef-flash model loaded` }
              }),
            )
            .otherwise((status) =>
              Promise.resolve({ ready: false, reason: `Ollama ${targetUrl} returned HTTP ${status}` }),
            ),
        )
        .catch((err: unknown): OllamaProbeResult => ({
          ready: false,
          reason: `Ollama ${targetUrl} probe failed: ${err instanceof Error ? err.message : String(err)}`,
        })),
    catch: (err): OllamaProbeResult => ({
      ready: false,
      reason: `Ollama ${targetUrl} probe failed: ${err instanceof Error ? err.message : String(err)}`,
    }),
  }).pipe(
    Effect.orElseSucceed((): OllamaProbeResult => ({
      ready: false,
      reason: `Ollama ${targetUrl} probe failed unexpectedly`,
    })),
  )
}

export function checkOllamaServerReady(
  baseUrl: string = process.env.HARNESS_OLLAMA_URL ??
    process.env.OLLAMA_HOST ??
    "http://127.0.0.1:11434",
): Effect.Effect<boolean> {
  return checkOllamaServerReadyDetailed(baseUrl).pipe(Effect.map((r) => r.ready))
}

export function ensureLocalOllamaReady(opts?: OllamaReadinessOptions): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const customUrl = process.env.HARNESS_OLLAMA_URL
    const baseUrl =
      opts?.baseUrl ?? customUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"
    const initialProbe = yield* checkOllamaServerReadyDetailed(baseUrl)
    if (initialProbe.ready) {
      return true
    }

    yield* Effect.try({
      try: () => {
        if (opts?.spawnOllama !== undefined) {
          opts.spawnOllama()
          return
        }
        if (customUrl === undefined) {
          const spawnRes = nodeSyncHostIo.spawnDetached("ollama", ["serve"], {
            env: {
              ...process.env,
              OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE ?? "-1",
            },
          })
          match(spawnRes)
            .with({ _tag: "Spawned" }, () => undefined)
            .with({ _tag: "SpawnFailed" }, ({ spawnError }) => {
              process.stderr.write(
                `[harness:ollama] Failed to spawn ollama serve: ${spawnError}\n`,
              )
            })
            .exhaustive()
        }
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))

    let lastReason = initialProbe.reason
    const maxRetries = opts?.maxRetries ?? (customUrl !== undefined ? 2 : 25)
    const retryDelayMs = opts?.retryDelayMs ?? (customUrl !== undefined ? 10 : 200)
    for (let i = 0; i < maxRetries; i++) {
      yield* Effect.sleep(`${retryDelayMs} millis`)
      const probe = yield* checkOllamaServerReadyDetailed(baseUrl)
      if (probe.ready) {
        return true
      }
      lastReason = probe.reason
    }
    process.stderr.write(`[harness:ollama] ${lastReason}\n`)
    return false
  })
}
