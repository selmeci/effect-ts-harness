/**
 * @module lsp-watchdog
 * Watchdog-bounded Effect Language Service (`effect-tsgo` / `tsgolint`) subprocess runner
 * with TS2484 cycle extraction, process-failure safety invariants, and ShadowFileOverlay fusion.
 */
import * as path from "node:path"
import { Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import {
  computeContentSha256,
  LspCommandName,
  LspDiagnosticsTimeoutError,
  toErrorReasonMessage,
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
import {
  DEFAULT_LSP_TIMEOUT_REASON_HINT,
  decodeLspDiagnosticsPayload,
  extractTs2484CycleHint,
  formatDiagKey,
  handleLspFailure,
  LspExecutionError,
  makeLspDiagnosticsReport,
  makeLspExceptionReport,
  makeLspToolErrorReport,
  resolveLspWatchdogTimeoutMs,
  toLspExecutionError,
  toLspTimeoutDiagnosticsReport,
} from "./lsp-watchdog-helpers.js"

export {
  extractTs2484CycleHint,
  handleLspFailure,
  makeLspDiagnosticsReport,
  makeLspExceptionReport,
  makeLspToolErrorReport,
  resolveLspWatchdogTimeoutMs,
  toLspExecutionError,
  toLspTimeoutDiagnosticsReport,
}

const DEFAULT_LSP_COMMAND = LspCommandName.make("effect-tsgo")

/** Execution options for {@link runLspDiagnosticsWithWatchdog}. */
export interface LspDiagnosticsExecutionOptions {
  readonly cache?: LspSessionCache | undefined
  readonly execTsgo?: LspTsgoExecutor | undefined
  readonly watchdogTimeoutMs?: number | undefined
  readonly commandName?: LspCommandName | undefined
}

/**
 * Runs `effect-tsgo` / `tsgolint` diagnostics under a watchdog timeout, merges TypeScript
 * ShadowFileOverlay diagnostics, and converts non-zero/signaled/spawn failures into `toolError` reports.
 */
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
    const commandName: LspCommandName = execOptions?.commandName ?? DEFAULT_LSP_COMMAND
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
        const filesChecked = Math.max(baseSummary.filesChecked, Object.keys(overlays).length)
        const totalFiles = Math.max(baseSummary.totalFiles, Object.keys(overlays).length)
        const processFailureDetail: Option.Option<{
          readonly code: string
          readonly message: string
        }> = match(activeProc)
          .with({ _tag: "Signaled" }, (p) =>
            Option.some({
              code: `LSP_SIGNAL_${p.signal}`,
              message: `[lsp-signal-${p.signal}] ${commandName} terminated by signal ${p.signal}`,
            }),
          )
          .with({ _tag: "SpawnFailed" }, (p) =>
            Option.some({
              code: "LSP_SPAWN_ERROR",
              message: `[lsp-spawn-error] ${commandName} failed to spawn: ${p.spawnError}`,
            }),
          )
          .with({ _tag: "Exited" }, (p) =>
            p.exitCode !== 0 &&
            errorCount === 0 &&
            warningCount === 0 &&
            baseSummary.filesWithoutPlugin === 0
              ? Option.some({
                  code: `LSP_EXIT_${p.exitCode}`,
                  message: `[lsp-exit-${p.exitCode}] ${commandName} exited with status ${p.exitCode} without reporting diagnostics`,
                })
              : Option.none(),
          )
          .exhaustive()

        return match(processFailureDetail)
          .with({ _tag: "Some" }, ({ value: failure }) => {
            process.stderr.write(
              `[harness-mcp] ${commandName} diagnostic process failure: ${failure.message}\n`,
            )
            const diagnosticsWithFailure: Array<unknown> = [
              ...mergedDiags,
              {
                file: resolvedFile ?? projectTsconfigPath ?? canonicalRoot,
                line: 1,
                column: 1,
                code: failure.code,
                severity: "error",
                message: failure.message,
                rule: "lsp-process-failure",
              },
            ]
            return makeLspToolErrorReport({
              diagnostics: diagnosticsWithFailure,
              filesChecked,
              filesWithoutPlugin: baseSummary.filesWithoutPlugin,
              totalFiles,
              errors: errorCount + 1,
              warnings: warningCount,
            })
          })
          .with({ _tag: "None" }, () =>
            makeLspDiagnosticsReport({
              diagnostics: mergedDiags,
              summary: {
                filesChecked,
                filesWithoutPlugin: baseSummary.filesWithoutPlugin,
                totalFiles,
                errors: errorCount,
                warnings: warningCount,
                messages: mergedDiags.length,
              },
            }),
          )
          .exhaustive()
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
        return makeLspToolErrorReport({
          diagnostics: combinedDiagnostics,
          filesChecked: tsDiags.length > 0 ? Object.keys(overlays).length : 0,
          filesWithoutPlugin: 0,
          totalFiles: tsDiags.length > 0 ? Object.keys(overlays).length : 0,
          errors: Math.max(1, errorCount),
          warnings: tsDiags.length > 0 ? warningCount : 0,
        })
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

/** Namespace entrypoint for watchdog-bounded LSP diagnostics execution. */
export const LspDiagnostics = {
  run: runLspDiagnosticsWithWatchdog,
} as const
