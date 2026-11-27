import { Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  OllamaEndpointUrl,
  OllamaModelName,
  OllamaWarmupError,
  OllamaWarmupStage,
  WorkflowTimeoutMs,
  toErrorReasonMessage,
} from "@harness/contract"

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
export const DEFAULT_CLEF_MODEL = "clef-flash"
export const DEFAULT_POLL_INTERVAL_MS = 200
export const DEFAULT_MAX_INTERRUPT_RETRIES = 4
export const TAGS_PROBE_TIMEOUT_MS = 2_000
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

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

export const OllamaTagsResponseSchema = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      model: Schema.optional(Schema.String),
    }),
  ),
})

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

export {
  buildSanitizedOllamaServeEnv,
  makeWarmupError,
  resolveConfiguredBaseUrl,
  toOllamaEndpointUrl,
  toOllamaModelName,
  toWorkflowTimeoutMs,
  validateLoopbackBaseUrl,
}
