/**
 * @module lsp-watchdog-helpers
 * Pure diagnostic payload parsing, timeout resolution, cycle-hint extraction, and
 * invariant-enforcing report constructors for {@link runLspDiagnosticsWithWatchdog}.
 */
import { Data, Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  DEFAULT_LSP_WATCHDOG_TIMEOUT_MS,
  LspDiagnosticHint,
  LspDiagnosticsTimeoutError,
  WorkflowTimeoutMs,
} from "@harness/contract"
import {
  type LspCleanDiagnosticsReport,
  type LspDiagnosticsSummary,
  type LspFindingsDiagnosticsReport,
  type LspTimeoutDiagnosticsReport,
  type LspToolErrorDiagnosticsReport,
} from "./mcp-helpers.js"

const LspDiagnosticsSummarySchema = Schema.Struct({
  filesChecked: Schema.Int,
  filesWithoutPlugin: Schema.Int,
  totalFiles: Schema.Int,
  errors: Schema.Int,
  warnings: Schema.Int,
  messages: Schema.Int,
})

const LspDiagnosticsPayloadSchema = Schema.Struct({
  diagnostics: Schema.Array(Schema.Unknown),
  summary: LspDiagnosticsSummarySchema,
})

/** Decodes JSON stdout emitted by `effect-tsgo` / `tsgolint` `--format json`. */
export const decodeLspDiagnosticsPayload = Schema.decodeOption(
  Schema.fromJsonString(LspDiagnosticsPayloadSchema),
)

const TS2484_CYCLE_PATTERN =
  /\bTS2484\b|Export declaration conflicts with exported declaration|circular(?:ly)?\s+(?:re-?export|references)/i

/** Default watchdog expiration reason attached to {@link LspDiagnosticsTimeoutError}. */
export const DEFAULT_LSP_TIMEOUT_REASON_HINT =
  "Watchdog timeout reached before LSP diagnostics completed (possible circular re-export cycle or unbounded type recursion)"

/** Extracts a single-line `TS2484` circular re-export hint from LSP stdout/stderr if present. */
export const extractTs2484CycleHint = (
  stdout: string,
  stderr: string,
): Option.Option<LspDiagnosticHint> => {
  const combined = `${stderr}\n${stdout}`
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const matchedLine = lines.find((line) => TS2484_CYCLE_PATTERN.test(line))
  if (matchedLine === undefined) {
    return Option.none()
  }
  const normalized = matchedLine.replace(/\s+/g, " ").trim()
  const withCode = /\bTS2484\b/i.test(normalized) ? normalized : `TS2484: ${normalized}`
  const bounded = withCode.slice(0, 512).trim()
  return Schema.decodeOption(LspDiagnosticHint)(bounded)
}

/** Resolves the effective LSP watchdog timeout from explicit option, `HARNESS_LSP_WATCHDOG_MS`, or default. */
export const resolveLspWatchdogTimeoutMs = (
  explicitTimeoutMs?: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowTimeoutMs => {
  if (explicitTimeoutMs !== undefined && Number.isFinite(explicitTimeoutMs)) {
    const decodedExplicit = Schema.decodeOption(WorkflowTimeoutMs)(Math.trunc(explicitTimeoutMs))
    const resolvedExplicit = match(decodedExplicit)
      .with({ _tag: "Some" }, ({ value }) => value)
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (resolvedExplicit !== undefined) {
      return resolvedExplicit
    }
  }
  const rawEnv = env["HARNESS_LSP_WATCHDOG_MS"]
  if (rawEnv !== undefined && rawEnv.trim().length > 0) {
    const parsed = Number(rawEnv.trim())
    if (Number.isFinite(parsed)) {
      const decodedEnv = Schema.decodeOption(WorkflowTimeoutMs)(Math.trunc(parsed))
      const resolvedEnv = match(decodedEnv)
        .with({ _tag: "Some" }, ({ value }) => value)
        .with({ _tag: "None" }, () => undefined)
        .exhaustive()
      if (resolvedEnv !== undefined) {
        return resolvedEnv
      }
    }
  }
  return DEFAULT_LSP_WATCHDOG_TIMEOUT_MS
}

/** Tagged internal execution error raised when LSP process preconditions or overlays throw. */
export class LspExecutionError extends Data.TaggedError("LspExecutionError")<{
  readonly cause: unknown
  readonly message: string
}> {}

/** Wraps an arbitrary LSP runner exception into a tagged {@link LspExecutionError}. */
export const toLspExecutionError = (cause: unknown): LspExecutionError =>
  new LspExecutionError({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

/**
 * Invariant-enforcing constructor for non-error diagnostic reports.
 * Only constructs `clean: true` when `errors === 0 && warnings === 0 && filesWithoutPlugin === 0`.
 */
export const makeLspDiagnosticsReport = (input: {
  readonly diagnostics: ReadonlyArray<unknown>
  readonly summary: LspDiagnosticsSummary
}): LspCleanDiagnosticsReport | LspFindingsDiagnosticsReport => {
  const isClean =
    input.summary.errors === 0 &&
    input.summary.warnings === 0 &&
    input.summary.filesWithoutPlugin === 0
  if (isClean) {
    return {
      clean: true,
      diagnostics: input.diagnostics,
      summary: input.summary,
    }
  }
  return {
    clean: false,
    diagnostics: input.diagnostics,
    summary: input.summary,
  }
}

/**
 * Invariant-enforcing constructor for LSP tool/process failures.
 * Guarantees `clean: false`, `toolError: true`, and `errors >= 1`.
 */
export const makeLspToolErrorReport = (input: {
  readonly diagnostics: ReadonlyArray<unknown>
  readonly filesChecked: number
  readonly filesWithoutPlugin: number
  readonly totalFiles: number
  readonly errors: number
  readonly warnings: number
}): LspToolErrorDiagnosticsReport => ({
  clean: false,
  toolError: true,
  diagnostics: input.diagnostics,
  summary: {
    filesChecked: input.filesChecked,
    filesWithoutPlugin: input.filesWithoutPlugin,
    totalFiles: input.totalFiles,
    errors: Math.max(1, input.errors),
    warnings: input.warnings,
    messages: input.diagnostics.length,
  },
})

/** Constructs a structured `toolError: true` report from an unexpected LSP exception or defect. */
export const makeLspExceptionReport = (cause: unknown): LspToolErrorDiagnosticsReport =>
  makeLspToolErrorReport({
    diagnostics: [`[lsp-exception] ${cause instanceof Error ? cause.message : String(cause)}`],
    filesChecked: 0,
    filesWithoutPlugin: 0,
    totalFiles: 0,
    errors: 1,
    warnings: 0,
  })

/** Logs an LSP execution failure to `stderr` and maps it into a {@link LspToolErrorDiagnosticsReport}. */
export const handleLspFailure = (err: unknown): Effect.Effect<LspToolErrorDiagnosticsReport> =>
  Effect.sync(() => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[harness-mcp] LSP diagnostics error: ${message}\n`)
    return makeLspExceptionReport(err)
  })

/** Maps a {@link LspDiagnosticsTimeoutError} into a structured `timedOut: true` MCP diagnostics report. */
export const toLspTimeoutDiagnosticsReport = (
  err: LspDiagnosticsTimeoutError,
  fallbackTargetPath: string,
): LspTimeoutDiagnosticsReport => ({
  clean: false,
  timedOut: true,
  errorTag: "LspDiagnosticsTimeoutError",
  timeoutMs: err.timeoutMs,
  ...(err.cycleHint !== undefined ? { cycleHint: err.cycleHint } : {}),
  diagnostics: [
    {
      file: err.targetPath ?? fallbackTargetPath,
      line: 1,
      column: 1,
      code:
        err.cycleHint !== undefined && err.cycleHint.includes("TS2484") ? "TS2484" : "LSP_TIMEOUT",
      severity: "error",
      message: err.reason,
      rule: "lsp-watchdog-timeout",
    },
  ],
  summary: {
    filesChecked: 0,
    filesWithoutPlugin: 0,
    totalFiles: 0,
    errors: 1,
    warnings: 0,
    messages: 1,
  },
})

const readStringProp = (d: object, key: string): string => {
  const val = Reflect.get(d, key)
  if (typeof val === "string" || typeof val === "number") {
    return String(val)
  }
  return ""
}

/** Produces a stable deduplication key for merged CLI + ShadowFileOverlay diagnostics. */
export const formatDiagKey = (d: unknown): string => {
  if (typeof d === "object" && d !== null) {
    return `${readStringProp(d, "file")}:${readStringProp(d, "line")}:${readStringProp(d, "column")}:${readStringProp(d, "code")}`
  }
  return typeof d === "string" ? d : JSON.stringify(d)
}
