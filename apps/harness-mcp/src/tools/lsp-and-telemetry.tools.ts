import * as path from "node:path"
import { Data, Effect, Option, Schema } from "effect"
import { match } from "ts-pattern"
import { computeContentSha256 } from "@harness/contract"
import { createTypeScriptProgramSession, evaluateOverlayDiagnostics } from "@harness/graph"
import { execFileAsyncEffect, nodeSyncHostIo } from "@harness/infra"
import type { SyncHostExecResult } from "@harness/service/host-io"
import {
  buildSessionReport,
  readFrictionEvents,
  readTelemetryEvents,
  renderSessionReportMarkdown,
} from "@harness/gates"
import {
  findRepoRoot,
  isPathInsideRoot,
  type LspDiagnosticsReport,
  McpToolName,
  type McpToolPluginDescriptor,
  normalizeProjectPathEffect,
  ProjectPathEscapeError,
  resolveContainedRepoRoot,
  type ServerOptions,
} from "./mcp-helpers.js"
import { hasValidWorkspaceRootMarker } from "./mcp-repo-root.js"
import {
  buildOverlayCacheKey,
  canonicalizePath,
  findNearestContainedTsconfig,
  type LspSessionCache,
  type LspTsgoExecutor,
  safeStatMtimeMs,
  tryCanonicalizeExistingRoot,
} from "./lsp-session-cache.js"

export type { LspDiagnosticsReport }

export interface LspDiagnosticsExecutionOptions {
  readonly cache?: LspSessionCache | undefined
  readonly execTsgo?: LspTsgoExecutor | undefined
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

const boundedNoNulPath = Schema.String.pipe(
  Schema.check(Schema.isBetweenLength(0, 1024), Schema.isPattern(/^[^\0]*$/)),
)
const pathField = (description: string) =>
  Schema.optional(boundedNoNulPath.annotate({ description }))

const LspDiagnosticsInputSchema = Schema.Struct({
  file: pathField("Optional file path to check for Effect Language Service diagnostics"),
  filePath: pathField(
    "Optional alias for file path to check for Effect Language Service diagnostics",
  ),
  project: pathField("Optional tsconfig.json path to check (defaults to tsconfig.base.json)"),
  tsconfigPath: pathField("Optional alias for project tsconfig.json path to check"),
  overlays: Schema.optional(
    Schema.Record(
      Schema.String.pipe(
        Schema.check(Schema.isBetweenLength(1, 512), Schema.isPattern(/^[^\0]+$/)),
      ),
      Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000_000))),
    )
      .pipe(Schema.check(Schema.isMaxProperties(200)))
      .annotate({
        description:
          "Optional map of relative/absolute file paths to in-memory TypeScript content for Shadow LSP verification",
      }),
  ),
  repoRoot: pathField("Optional repository root path"),
})

const TelemetryReportInputSchema = Schema.Struct({
  format: Schema.optional(
    Schema.Literals(["json", "markdown"]).annotate({
      description: "Report output format (defaults to 'json')",
    }),
  ),
  cumulative: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Whether to report cumulative metrics across sessions instead of just the active task",
    }),
  ),
  repoRoot: pathField("Optional repository root path"),
})

const decodeLspDiagnosticsInput = Schema.decodeUnknownEffect(LspDiagnosticsInputSchema)
const decodeTelemetryReportInput = Schema.decodeUnknownEffect(TelemetryReportInputSchema)

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

class LspExecutionError extends Data.TaggedError("LspExecutionError")<{
  readonly cause: unknown
  readonly message: string
}> {}

const toLspExecutionError = (cause: unknown): LspExecutionError =>
  new LspExecutionError({
    cause,
    message: cause instanceof Error ? cause.message : String(cause),
  })

const makeLspExceptionReport = (cause: unknown): LspDiagnosticsReport => ({
  clean: false,
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

const handleLspFailure = (err: unknown): Effect.Effect<LspDiagnosticsReport> =>
  Effect.sync(() => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[harness-mcp] LSP diagnostics error: ${message}\n`)
    return makeLspExceptionReport(err)
  })

const runSyncLspBranch = (fn: () => LspDiagnosticsReport): Effect.Effect<LspDiagnosticsReport> =>
  Effect.try({
    try: fn,
    catch: toLspExecutionError,
  }).pipe(
    Effect.catch(handleLspFailure),
    Effect.catchDefect((defect) => {
      const message = defect instanceof Error ? defect.message : String(defect)
      process.stderr.write(`[harness-mcp] LSP diagnostics defect: ${message}\n`)
      return Effect.succeed(makeLspExceptionReport(defect))
    }),
  )

export const runDefaultLspDiagnostics = (
  repoRoot: string,
  input: {
    readonly file?: string | undefined
    readonly filePath?: string | undefined
    readonly project?: string | undefined
    readonly tsconfigPath?: string | undefined
  },
  execOptions?: LspDiagnosticsExecutionOptions,
): Effect.Effect<LspDiagnosticsReport, ProjectPathEscapeError> =>
  Effect.gen(function* () {
    const canonicalRoot = yield* match(tryCanonicalizeExistingRoot(repoRoot, nodeSyncHostIo))
      .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
      .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(toLspExecutionError(failure)))
      .exhaustive()
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
    const binPath = path.join(findRepoRoot(canonicalRoot), "node_modules", ".bin", "effect-tsgo")
    const execTsgo = execOptions?.execTsgo ?? execFileAsyncEffect
    const runTsgoEffect = (): Effect.Effect<SyncHostExecResult, string> =>
      execTsgo(binPath, cliArgs, { cwd: repoRoot, timeoutMs: 30_000 }).pipe(
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
              binPath,
              canonicalFile ?? null,
              canonicalProject ?? null,
              initialFileMtimeMs ?? null,
              cache.getTsconfigMtimeKey(canonicalRoot, canonicalProject),
            ]),
            runTsgoEffect,
          )
        : yield* runTsgoEffect()

    const stdout = (proc.stdout ?? "").trim()
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
    const procFailed = match(proc)
      .with({ _tag: "Exited" }, (p) => p.exitCode !== 0)
      .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => true)
      .exhaustive()

    match(decoded)
      .with({ _tag: "None" }, () => {
        if (procFailed && Object.keys(overlays).length === 0) {
          const errMsg = proc.stderr.trim()
          process.stderr.write(`[harness-mcp] effect-tsgo diagnostic process failure: ${errMsg}\n`)
          mergedDiags.push({
            file: resolvedFile ?? repoRoot,
            line: 1,
            column: 1,
            message: `effect-tsgo execution failed: ${errMsg}`,
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
        match(proc)
          .with({ _tag: "Exited" }, (p) => {
            if (p.exitCode !== 0) {
              failureDetails.push(
                `[lsp-exit-${p.exitCode}] effect-tsgo exited with status ${p.exitCode}`,
              )
            }
          })
          .with({ _tag: "TimedOut" }, (p) => {
            failureDetails.push(
              `[lsp-timeout] effect-tsgo timed out${p.signal ? ` (${p.signal})` : ""}`,
            )
          })
          .with({ _tag: "Signaled" }, (p) => {
            failureDetails.push(
              `[lsp-signal-${p.signal}] effect-tsgo terminated by signal ${p.signal}`,
            )
          })
          .with({ _tag: "SpawnFailed" }, (p) => {
            failureDetails.push(`[lsp-spawn-error] effect-tsgo failed to spawn: ${p.spawnError}`)
          })
          .exhaustive()
        const stderrText = proc.stderr.trim()
        if (stderrText.length > 0) {
          failureDetails.push(stderrText)
        }
        if (stderrText.length === 0 && stdout.length > 0) {
          failureDetails.push(stdout)
        }
        if (failureDetails.length === 0) {
          failureDetails.push("[lsp-error] effect-tsgo produced no valid JSON diagnostic payload")
        }

        const combinedDiagnostics: Array<unknown> =
          tsDiags.length > 0 ? [...failureDetails, ...mergedDiags] : failureDetails
        return {
          clean: false,
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
      (err): err is LspExecutionError | string => !(err instanceof ProjectPathEscapeError),
      handleLspFailure,
    ),
    Effect.catchDefect((defect) => {
      const message = defect instanceof Error ? defect.message : String(defect)
      process.stderr.write(`[harness-mcp] LSP diagnostics defect: ${message}\n`)
      return Effect.succeed(makeLspExceptionReport(defect))
    }),
  )

const evaluateOverlaysDiagnostics = (
  root: string,
  overlays: Record<string, string>,
  file: string | undefined,
  project: string | undefined,
  lspSessionCache?: LspSessionCache,
): LspDiagnosticsReport => {
  const candidatesToCheck: Array<readonly [label: string, value: string]> = [
    ...Object.keys(overlays).map((k) => ["Overlay", k] as const),
    ...(file !== undefined && file.length > 0 ? ([["File", file]] as const) : []),
    ...(project !== undefined && project.length > 0 ? ([["Project", project]] as const) : []),
  ]
  const escapeDiags = candidatesToCheck.flatMap(([label, candidate]) => {
    const absPath = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(root, candidate)
    return isPathInsideRoot(root, absPath)
      ? []
      : [
          {
            file: candidate,
            line: 1,
            column: 1,
            code: "PATH_TRAVERSAL",
            severity: "error" as const,
            message: `${label} path '${candidate}' escapes repository root.`,
          },
        ]
  })
  if (escapeDiags.length > 0) {
    return {
      clean: false,
      diagnostics: escapeDiags,
      summary: {
        filesChecked: 0,
        filesWithoutPlugin: 0,
        totalFiles: Object.keys(overlays).length,
        errors: escapeDiags.length,
        warnings: 0,
        messages: escapeDiags.length,
      },
    }
  }

  const toRootRelPosix = (p: string): string =>
    path
      .relative(root, path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p))
      .replace(/\\/g, "/")
  const targetRelFile =
    file !== undefined && file.trim().length > 0 ? toRootRelPosix(file) : undefined
  const matchesTargetFile = (candidate: string): boolean => {
    if (targetRelFile === undefined) return true
    return toRootRelPosix(candidate) === targetRelFile
  }
  const compilableKeys = Object.keys(overlays).filter(
    (k) => (k.endsWith(".ts") || k.endsWith(".tsx")) && !k.endsWith(".d.ts"),
  )
  const matchedKeys =
    targetRelFile !== undefined ? compilableKeys.filter(matchesTargetFile) : compilableKeys
  const projectTsconfigPath =
    project !== undefined && project.trim().length > 0
      ? path.isAbsolute(project)
        ? path.resolve(project)
        : path.resolve(root, project)
      : undefined
  const session =
    lspSessionCache !== undefined
      ? lspSessionCache.getSession(root, projectTsconfigPath)
      : createTypeScriptProgramSession(root, nodeSyncHostIo)
  const diags = evaluateOverlayDiagnostics(root, overlays, session)
  const filteredDiags =
    targetRelFile !== undefined ? diags.filter((d) => matchesTargetFile(d.file)) : diags
  const errors = filteredDiags.filter((d) => d.severity === "error").length
  const warnings = filteredDiags.filter((d) => d.severity === "warning").length
  return {
    clean: matchedKeys.length > 0 && errors === 0 && warnings === 0,
    diagnostics: filteredDiags,
    summary: {
      filesChecked: matchedKeys.length,
      filesWithoutPlugin: 0,
      totalFiles: Object.keys(overlays).length,
      errors,
      warnings,
      messages: filteredDiags.length,
    },
  }
}

export const buildLspAndTelemetryToolDescriptors = (
  options?: ServerOptions,
  lspSessionCache?: LspSessionCache,
): ReadonlyArray<McpToolPluginDescriptor> => [
  {
    name: McpToolName.make("harness_lsp_diagnostics"),
    description:
      "Run Effect Language Service (@effect/tsgo) strict JSON diagnostics on a specific file or tsconfig project, or evaluate in-memory ShadowFileOverlay content in <35ms",
    inputSchema: LspDiagnosticsInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const typedArgs = yield* decodeLspDiagnosticsInput(args)
        const file = typedArgs.file ?? typedArgs.filePath
        const project = typedArgs.project ?? typedArgs.tsconfigPath
        const overlays = typedArgs.overlays
        const root = yield* resolveContainedRepoRoot(typedArgs.repoRoot, options)
        if (overlays !== undefined && Object.keys(overlays).length > 0) {
          if (!nodeSyncHostIo.existsSync(root) || !nodeSyncHostIo.isDirectorySync(root)) {
            return yield* new ProjectPathEscapeError({
              projectPath: root,
              repoRoot: root,
              message: `Resolved repoRoot '${root}' does not exist or is not a directory. Pass an explicit 'repoRoot' pointing to an existing repository root.`,
            })
          }
          return yield* runSyncLspBranch(() =>
            evaluateOverlaysDiagnostics(root, overlays, file, project, lspSessionCache),
          )
        }
        if (options?.lspDiagnosticsRunner !== undefined) {
          const runner = options.lspDiagnosticsRunner
          return yield* runSyncLspBranch(() => runner({ file, project }))
        }
        if (!hasValidWorkspaceRootMarker(findRepoRoot(root))) {
          return yield* new ProjectPathEscapeError({
            projectPath: root,
            repoRoot: root,
            message: `Resolved repoRoot '${root}' is not a valid workspace root (missing 'pnpm-workspace.yaml' or '.git'). Pass an explicit 'repoRoot' pointing to the repository root.`,
          })
        }
        return yield* runDefaultLspDiagnostics(
          root,
          { file, project },
          { cache: lspSessionCache, execTsgo: options?.lspTsgoExecutor },
        )
      }),
  },
  {
    name: McpToolName.make("harness_telemetry_report"),
    description:
      "Generate a session observability and tool-usage health report across CLI, hooks, and MCP tools",
    inputSchema: TelemetryReportInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { format, cumulative, repoRoot } = yield* decodeTelemetryReportInput(args)
        const root = yield* resolveContainedRepoRoot(repoRoot, options)
        const events = readTelemetryEvents(root, nodeSyncHostIo)
        const frictionEvents = readFrictionEvents(root, nodeSyncHostIo)
        const baseReport = buildSessionReport({
          events,
          frictionEvents,
          ...(cumulative === true ? { cumulative: true } : {}),
        })
        const report = hasValidWorkspaceRootMarker(findRepoRoot(root))
          ? baseReport
          : {
              ...baseReport,
              recommendations: [
                ...baseReport.recommendations,
                `Warning: resolvedRepoRoot '${root}' is not a valid workspace root (missing 'pnpm-workspace.yaml' or '.git'). Pass an explicit 'repoRoot' pointing to the repository root.`,
              ],
            }
        if (format === "markdown") {
          return { markdown: renderSessionReportMarkdown(report), report, resolvedRepoRoot: root }
        }
        return { ...report, resolvedRepoRoot: root }
      }),
  },
]
