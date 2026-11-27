import * as path from "node:path"
import { Data, Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  computeContentSha256,
  DEFAULT_LSP_WATCHDOG_TIMEOUT_MS,
  LspCommandName,
  LspDiagnosticHint,
  LspDiagnosticsTimeoutError,
  toErrorReasonMessage,
  WorkflowTimeoutMs,
  WorkspaceFilePath,
} from "@harness/contract"
import { createTypeScriptProgramSession, evaluateOverlayDiagnostics } from "@harness/graph"
import { execFileAsyncEffect, nodeSyncHostIo } from "@harness/infra"
import type { SyncHostExecResult } from "@harness/service/host-io"
import {
  findRepoRoot,
  isPathInsideRoot,
  type LspDiagnosticsReport,
  normalizeProjectPathEffect,
  ProjectPathEscapeError,
} from "./mcp-helpers.js"
import {
  buildOverlayCacheKey,
  canonicalizePath,
  findNearestContainedTsconfig,
  type LspSessionCache,
  type LspTsgoExecutor,
  safeStatMtimeMs,
  tryCanonicalizeExistingRoot,
} from "./lsp-session-cache.js"

export type LspCommandKind = "effect-tsgo" | "tsgolint"

export interface LspDiagnosticsExecutionOptions {
  readonly cache?: LspSessionCache | undefined
  readonly execTsgo?: LspTsgoExecutor | undefined
  readonly watchdogTimeoutMs?: number | undefined
  readonly commandName?: LspCommandKind | undefined
}

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

const decodeLspDiagnosticsPayload = Schema.decodeOption(
  Schema.fromJsonString(LspDiagnosticsPayloadSchema),
)

const TS2484_CYCLE_PATTERN =
  /\bTS2484\b|Export declaration conflicts with exported declaration|circular(?:ly)?\s+(?:re-?export|references)/i

const DEFAULT_LSP_TIMEOUT_REASON_HINT =
  "Watchdog timeout reached before LSP diagnostics completed (possible circular re-export cycle or unbounded type recursion)"

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

class LspExecutionError extends Data.TaggedError("LspExecutionError")<{
  readonly cause: unknown
  readonly message: string
}> {}

export const toLspExecutionError = (cause: unknown): LspExecutionError =>
  new LspExecutionError({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

export const makeLspExceptionReport = (cause: unknown): LspDiagnosticsReport => ({
  clean: false,
  toolError: true,
  diagnostics: [`[lsp-exception] ${cause instanceof Error ? cause.message : String(cause)}`],
  summary: {
    filesChecked: 0,
    filesWithoutPlugin: 0,
    totalFiles: 0,
    errors: 1,
    warnings: 0,
    messages: 1,
  },
})

export const handleLspFailure = (err: unknown): Effect.Effect<LspDiagnosticsReport> =>
  Effect.sync(() => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[harness-mcp] LSP diagnostics error: ${message}\n`)
    return makeLspExceptionReport(err)
  })

export const toLspTimeoutDiagnosticsReport = (
  err: LspDiagnosticsTimeoutError,
  fallbackTargetPath: string,
): LspDiagnosticsReport => ({
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

const formatDiagKey = (d: unknown): string => {
  if (typeof d === "object" && d !== null) {
    return `${readStringProp(d, "file")}:${readStringProp(d, "line")}:${readStringProp(d, "column")}:${readStringProp(d, "code")}`
  }
  return typeof d === "string" ? d : JSON.stringify(d)
}

export const runLspDiagnosticsWithWatchdog = Effect.fn("LspDiagnostics.run")(function* (
  repoRoot: string,
  input: {
    readonly file?: string | undefined
    readonly filePath?: string | undefined
    readonly project?: string | undefined
    readonly tsconfigPath?: string | undefined
    readonly watchdogTimeoutMs?: number | undefined
  },
  execOptions?: LspDiagnosticsExecutionOptions,
): Effect.fn.Return<LspDiagnosticsReport, ProjectPathEscapeError | LspDiagnosticsTimeoutError> {
  return yield* Effect.gen(function* () {
    const canonicalRoot = yield* match(tryCanonicalizeExistingRoot(repoRoot, nodeSyncHostIo))
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(toLspExecutionError(failure)))
      .exhaustive()
    const commandName: LspCommandKind = execOptions?.commandName ?? "effect-tsgo"
    const watchdogTimeoutMs = resolveLspWatchdogTimeoutMs(
      input.watchdogTimeoutMs ?? execOptions?.watchdogTimeoutMs,
    )
    const cliArgs = ["diagnostics", "--strict", "--format", "json"]
    const effectiveFile = input.file ?? input.filePath
    const effectiveProject = input.project ?? input.tsconfigPath
    let resolvedFile: string | undefined
    let projectTsconfigPath: string | undefined

    if (effectiveFile !== undefined && effectiveFile.trim().length > 0) {
      resolvedFile = path.isAbsolute(effectiveFile)
        ? path.resolve(effectiveFile)
        : path.resolve(repoRoot, effectiveFile)
      if (!isPathInsideRoot(repoRoot, resolvedFile)) {
        return yield* new ProjectPathEscapeError({
          projectPath: effectiveFile,
          repoRoot,
          message: `File path '${effectiveFile}' escapes repository root '${repoRoot}'.`,
        })
      }
      if (effectiveProject !== undefined && effectiveProject.trim().length > 0) {
        projectTsconfigPath = yield* normalizeProjectPathEffect(repoRoot, effectiveProject)
        cliArgs.push("--project", projectTsconfigPath)
      } else {
        const targetFile = resolvedFile
        const discovered = yield* Effect.try({
          try: () => findNearestContainedTsconfig(repoRoot, targetFile, nodeSyncHostIo),
          catch: toLspExecutionError,
        })
        const maybeEscape = match(discovered)
          .with({ _tag: "Escaped" }, ({ path: escapedPath }) =>
            Effect.fail(
              new ProjectPathEscapeError({
                projectPath: escapedPath,
                repoRoot,
                message: `Project path '${escapedPath}' escapes repository root '${repoRoot}'.`,
              }),
            ),
          )
          .with({ _tag: "Found" }, ({ path: foundPath }) =>
            Effect.sync(() => {
              projectTsconfigPath = foundPath
              cliArgs.push("--project", foundPath)
            }),
          )
          .with({ _tag: "None" }, () => Effect.void)
          .exhaustive()
        yield* maybeEscape
      }
      cliArgs.push("--file", resolvedFile)
    } else {
      const rawProject = effectiveProject ?? "tsconfig.base.json"
      projectTsconfigPath = yield* normalizeProjectPathEffect(repoRoot, rawProject)
      cliArgs.push("--project", projectTsconfigPath)
    }

    const canonicalFile =
      resolvedFile !== undefined ? canonicalizePath(resolvedFile, nodeSyncHostIo) : undefined
    const canonicalProject =
      projectTsconfigPath !== undefined
        ? canonicalizePath(projectTsconfigPath, nodeSyncHostIo)
        : undefined
    const initialFileMtimeMs =
      canonicalFile !== undefined ? safeStatMtimeMs(canonicalFile, nodeSyncHostIo) : undefined
    const binPath = path.join(findRepoRoot(canonicalRoot), "node_modules", ".bin", commandName)
    const execTsgo = execOptions?.execTsgo ?? execFileAsyncEffect
    const runTsgoEffect = (): Effect.Effect<SyncHostExecResult, string> =>
      execTsgo(binPath, cliArgs, { cwd: repoRoot, timeoutMs: watchdogTimeoutMs }).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(defect instanceof Error ? defect.message : String(defect)),
        ),
      )

    const cache = execOptions?.cache
    const proc =
      cache !== undefined
        ? yield* cache.runSingleFlightTsgo(
            JSON.stringify([
              canonicalRoot,
              commandName,
              binPath,
              watchdogTimeoutMs,
              canonicalFile ?? null,
              canonicalProject ?? null,
              initialFileMtimeMs ?? null,
              cache.getTsconfigMtimeKey(canonicalRoot, canonicalProject),
            ]),
            runTsgoEffect,
          )
        : yield* runTsgoEffect()

    const activeProc = yield* match(proc)
      .with({ _tag: "TimedOut" }, (timedOut) => {
        const cycleHint = Option.getOrUndefined(
          extractTs2484CycleHint(timedOut.stdout, timedOut.stderr),
        )
        const targetCandidate = (resolvedFile ?? projectTsconfigPath ?? canonicalRoot).trim()
        const targetPath = match(Schema.decodeOption(WorkspaceFilePath)(targetCandidate))
          .with({ _tag: "Some" }, ({ value }) => value)
          .with({ _tag: "None" }, () => undefined)
          .exhaustive()
        return Effect.fail(
          new LspDiagnosticsTimeoutError({
            command: LspCommandName.make(commandName),
            timeoutMs: watchdogTimeoutMs,
            ...(targetPath !== undefined ? { targetPath } : {}),
            ...(cycleHint !== undefined ? { cycleHint } : {}),
            reason: toErrorReasonMessage(
              `${commandName} timed out after ${watchdogTimeoutMs}ms${timedOut.signal ? ` (${timedOut.signal})` : ""}: ${cycleHint ?? DEFAULT_LSP_TIMEOUT_REASON_HINT}`,
            ),
          }),
        )
      })
      .with({ _tag: "Exited" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, (nonTimeout) =>
        Effect.succeed(nonTimeout),
      )
      .exhaustive()

    const stdout = (activeProc.stdout ?? "").trim()
    const decoded = decodeLspDiagnosticsPayload(stdout)

    const overlays: Record<string, string> = {}
    if (
      resolvedFile !== undefined &&
      canonicalFile !== undefined &&
      (resolvedFile.endsWith(".ts") || resolvedFile.endsWith(".tsx")) &&
      !resolvedFile.endsWith(".test.ts") &&
      !resolvedFile.endsWith(".spec.ts") &&
      !resolvedFile.endsWith(".test.tsx") &&
      !resolvedFile.endsWith(".spec.tsx")
    ) {
      const canReadOverlayFile = yield* Effect.try({
        try: () =>
          isPathInsideRoot(canonicalRoot, canonicalFile) &&
          nodeSyncHostIo.existsSync(canonicalFile) &&
          !nodeSyncHostIo.isSymbolicLinkSync(resolvedFile) &&
          !nodeSyncHostIo.isSymbolicLinkSync(canonicalFile) &&
          nodeSyncHostIo.isFileSync(canonicalFile),
        catch: toLspExecutionError,
      })
      if (canReadOverlayFile) {
        overlays[canonicalFile] = yield* Effect.try({
          try: () => nodeSyncHostIo.readTextSync(canonicalFile),
          catch: toLspExecutionError,
        })
      }
    }

    const resolvedFileMtimeMs =
      canonicalFile !== undefined ? safeStatMtimeMs(canonicalFile, nodeSyncHostIo) : undefined
    const tsDiags =
      Object.keys(overlays).length > 0 && canonicalFile !== undefined
        ? yield* Effect.try({
            try: () => {
              const fileContent = overlays[canonicalFile] ?? ""
              const contentSha256 = computeContentSha256(fileContent)
              const cacheKey = buildOverlayCacheKey(
                canonicalRoot,
                canonicalFile,
                canonicalProject,
                nodeSyncHostIo,
              )
              if (cache !== undefined) {
                const cached = cache.getCachedOverlayDiagnostics({
                  repoRoot: canonicalRoot,
                  cacheKey,
                  filePath: canonicalFile,
                  fileMtimeMs: resolvedFileMtimeMs,
                  contentSha256,
                  projectTsconfigPath: canonicalProject,
                })
                if (cached !== undefined) {
                  return cached
                }
              }
              const session =
                cache !== undefined
                  ? cache.getSession(canonicalRoot, canonicalProject)
                  : createTypeScriptProgramSession(canonicalRoot, nodeSyncHostIo)
              const freshDiags = evaluateOverlayDiagnostics(
                canonicalRoot,
                overlays,
                session,
              ).filter((d) => d.code !== "TS2591" && d.code !== "TS2580")
              if (cache !== undefined) {
                cache.setCachedOverlayDiagnostics({
                  repoRoot: canonicalRoot,
                  cacheKey,
                  filePath: canonicalFile,
                  fileMtimeMs: resolvedFileMtimeMs,
                  contentSha256,
                  session,
                  diagnostics: freshDiags,
                  projectTsconfigPath: canonicalProject,
                })
              }
              return freshDiags
            },
            catch: toLspExecutionError,
          })
        : []

    const effectGoDiags: ReadonlyArray<unknown> = Option.match(decoded, {
      onNone: () => [],
      onSome: (d) => d.diagnostics,
    })

    const seen = new Set<string>()
    const mergedDiags: Array<unknown> = []
    const procFailed = match(activeProc)
      .with({ _tag: "Exited" }, (p) => p.exitCode !== 0)
      .with({ _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => true)
      .exhaustive()

    match(decoded)
      .with({ _tag: "None" }, () => {
        if (procFailed && Object.keys(overlays).length === 0) {
          const errMsg = activeProc.stderr.trim()
          process.stderr.write(
            `[harness-mcp] ${commandName} diagnostic process failure: ${errMsg}\n`,
          )
          mergedDiags.push({
            file: resolvedFile ?? repoRoot,
            line: 1,
            column: 1,
            message: `${commandName} execution failed: ${errMsg}`,
            severity: "warning",
            rule: "lsp-spawn-error",
          })
        }
      })
      .with({ _tag: "Some" }, () => undefined)
      .exhaustive()
    for (const d of [...effectGoDiags, ...tsDiags]) {
      const key = formatDiagKey(d)
      if (!seen.has(key)) {
        seen.add(key)
        mergedDiags.push(d)
      }
    }

    let errorCount = 0
    let warningCount = 0
    for (const d of mergedDiags) {
      if (typeof d === "object" && d !== null && Reflect.get(d, "severity") === "warning") {
        warningCount += 1
      } else {
        errorCount += 1
      }
    }

    return match(decoded)
      .with({ _tag: "Some" }, ({ value }) => {
        const baseSummary = value.summary
        const summary = {
          filesChecked: Math.max(baseSummary.filesChecked, Object.keys(overlays).length),
          filesWithoutPlugin: baseSummary.filesWithoutPlugin,
          totalFiles: Math.max(baseSummary.totalFiles, Object.keys(overlays).length),
          errors: errorCount,
          warnings: warningCount,
          messages: mergedDiags.length,
        }
        return {
          clean: summary.errors === 0 && summary.warnings === 0 && summary.filesWithoutPlugin === 0,
          diagnostics: mergedDiags,
          summary,
        } satisfies LspDiagnosticsReport
      })
      .with({ _tag: "None" }, () => {
        const failureDetails: Array<string> = []
        match(activeProc)
          .with({ _tag: "Exited" }, (p) => {
            if (p.exitCode !== 0) {
              failureDetails.push(
                `[lsp-exit-${p.exitCode}] ${commandName} exited with status ${p.exitCode}`,
              )
            }
          })
          .with({ _tag: "Signaled" }, (p) => {
            failureDetails.push(
              `[lsp-signal-${p.signal}] ${commandName} terminated by signal ${p.signal}`,
            )
          })
          .with({ _tag: "SpawnFailed" }, (p) => {
            failureDetails.push(`[lsp-spawn-error] ${commandName} failed to spawn: ${p.spawnError}`)
          })
          .exhaustive()
        const stderrText = activeProc.stderr.trim()
        if (stderrText.length > 0) {
          failureDetails.push(stderrText)
        }
        if (stderrText.length === 0 && stdout.length > 0) {
          failureDetails.push(stdout)
        }
        if (failureDetails.length === 0) {
          failureDetails.push(
            `[lsp-error] ${commandName} produced no valid JSON diagnostic payload`,
          )
        }

        const combinedDiagnostics: Array<unknown> =
          tsDiags.length > 0 ? [...failureDetails, ...mergedDiags] : failureDetails
        return {
          clean: false,
          toolError: true,
          diagnostics: combinedDiagnostics,
          summary: {
            filesChecked: tsDiags.length > 0 ? Object.keys(overlays).length : 0,
            filesWithoutPlugin: 0,
            totalFiles: tsDiags.length > 0 ? Object.keys(overlays).length : 0,
            errors: Math.max(1, errorCount),
            warnings: warningCount,
            messages: combinedDiagnostics.length,
          },
        } satisfies LspDiagnosticsReport
      })
      .exhaustive()
  }).pipe(
    Effect.catchIf(
      (err): err is LspExecutionError | string =>
        !(err instanceof ProjectPathEscapeError) && !(err instanceof LspDiagnosticsTimeoutError),
      handleLspFailure,
    ),
    Effect.catchDefect((defect) => {
      const message = defect instanceof Error ? defect.message : String(defect)
      process.stderr.write(`[harness-mcp] LSP diagnostics defect: ${message}\n`)
      return Effect.succeed(makeLspExceptionReport(defect))
    }),
  )
})

export const LspDiagnostics = {
  run: runLspDiagnosticsWithWatchdog,
} as const
