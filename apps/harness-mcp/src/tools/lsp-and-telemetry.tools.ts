import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { Data, Effect, Option, Schema } from "effect"
import { evaluateOverlayDiagnostics, getOrCreateWarmProgramSession } from "@harness/graph"
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
  resolveDefaultRepoRoot,
  type ServerOptions,
} from "./mcp-helpers.js"

export type { LspDiagnosticsReport }

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

const LspDiagnosticsInputSchema = Schema.Struct({
  file: Schema.optional(
    Schema.String.annotate({
      description: "Optional file path to check for Effect Language Service diagnostics",
    }),
  ),
  filePath: Schema.optional(
    Schema.String.annotate({
      description: "Optional alias for file path to check for Effect Language Service diagnostics",
    }),
  ),
  project: Schema.optional(
    Schema.String.annotate({
      description: "Optional tsconfig.json path to check (defaults to tsconfig.base.json)",
    }),
  ),
  tsconfigPath: Schema.optional(
    Schema.String.annotate({
      description: "Optional alias for project tsconfig.json path to check",
    }),
  ),
  overlays: Schema.optional(
    Schema.Record(
      Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, 512))),
      Schema.String.pipe(Schema.check(Schema.isMaxLength(1_000_000))),
    )
      .pipe(Schema.check(Schema.isMaxProperties(200)))
      .annotate({
        description:
          "Optional map of relative/absolute file paths to in-memory TypeScript content for Shadow LSP verification",
      }),
  ),
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
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
  repoRoot: Schema.optional(
    Schema.String.annotate({
      description: "Optional repository root path",
    }),
  ),
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

export const runDefaultLspDiagnostics = (
  repoRoot: string,
  input: {
    readonly file?: string | undefined
    readonly filePath?: string | undefined
    readonly project?: string | undefined
    readonly tsconfigPath?: string | undefined
  },
): Effect.Effect<LspDiagnosticsReport> =>
  Effect.gen(function* () {
    const cliArgs = ["diagnostics", "--strict", "--format", "json"]
    const effectiveFile = input.file ?? input.filePath
    const effectiveProject = input.project ?? input.tsconfigPath
    let resolvedFile: string | undefined

    if (effectiveFile !== undefined && effectiveFile.trim().length > 0) {
      resolvedFile = path.isAbsolute(effectiveFile)
        ? path.resolve(effectiveFile)
        : path.resolve(repoRoot, effectiveFile)
      if (!isPathInsideRoot(repoRoot, resolvedFile)) {
        return yield* Effect.fail(
          `File path '${effectiveFile}' escapes repository root '${repoRoot}'.`,
        )
      }
      if (effectiveProject !== undefined && effectiveProject.trim().length > 0) {
        cliArgs.push("--project", yield* normalizeProjectPathEffect(repoRoot, effectiveProject))
      } else {
        const normalizedRepoRoot = path.resolve(repoRoot)
        let curr = path.dirname(resolvedFile)
        while (isPathInsideRoot(normalizedRepoRoot, curr) && curr !== normalizedRepoRoot) {
          const candidate = path.join(curr, "tsconfig.json")
          const candidateExists = yield* Effect.try({
            try: () => fs.existsSync(candidate),
            catch: toLspExecutionError,
          })
          if (candidateExists) {
            cliArgs.push("--project", candidate)
            break
          }
          const parent = path.dirname(curr)
          if (parent === curr) {
            break
          }
          curr = parent
        }
      }
      cliArgs.push("--file", resolvedFile)
    } else {
      const rawProject = effectiveProject ?? "tsconfig.base.json"
      cliArgs.push("--project", yield* normalizeProjectPathEffect(repoRoot, rawProject))
    }

    const binPath = path.join(findRepoRoot(repoRoot), "node_modules", ".bin", "effect-tsgo")
    const proc = yield* Effect.try({
      try: () =>
        spawnSync(binPath, cliArgs, {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 30_000,
        }),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    })

    const stdout = (proc.stdout ?? "").trim()
    const decoded = decodeLspDiagnosticsPayload(stdout)

    const overlays: Record<string, string> = {}
    if (
      resolvedFile !== undefined &&
      (resolvedFile.endsWith(".ts") || resolvedFile.endsWith(".tsx")) &&
      !resolvedFile.endsWith(".test.ts") &&
      !resolvedFile.endsWith(".spec.ts") &&
      !resolvedFile.endsWith(".test.tsx") &&
      !resolvedFile.endsWith(".spec.tsx")
    ) {
      const fileExists = yield* Effect.try({
        try: () => fs.existsSync(resolvedFile),
        catch: toLspExecutionError,
      })
      if (fileExists) {
        overlays[resolvedFile] = yield* Effect.try({
          try: () => fs.readFileSync(resolvedFile, "utf-8"),
          catch: toLspExecutionError,
        })
      }
    }

    const tsDiags =
      Object.keys(overlays).length > 0
        ? yield* Effect.try({
            try: () =>
              evaluateOverlayDiagnostics(
                repoRoot,
                overlays,
                getOrCreateWarmProgramSession(repoRoot),
              ).filter((d) => d.code !== "TS2591" && d.code !== "TS2580"),
            catch: toLspExecutionError,
          })
        : []

    const effectGoDiags: ReadonlyArray<unknown> = Option.match(decoded, {
      onNone: () => [],
      onSome: (d) => d.diagnostics,
    })

    const seen = new Set<string>()
    const mergedDiags: Array<unknown> = []
    if (
      Option.isNone(decoded) &&
      (proc.error !== undefined || (proc.status !== null && proc.status !== 0)) &&
      Object.keys(overlays).length === 0
    ) {
      const errMsg = proc.error !== undefined ? proc.error.message : (proc.stderr ?? "").trim()
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
    for (const d of effectGoDiags) {
      const key = formatDiagKey(d)
      if (!seen.has(key)) {
        seen.add(key)
        mergedDiags.push(d)
      }
    }
    for (const d of tsDiags) {
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

    if (Option.isSome(decoded)) {
      const baseSummary = decoded.value.summary
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
    }

    const failureDetails: Array<string> = []
    if (proc.error) {
      failureDetails.push(`[lsp-spawn-error] ${proc.error.message}`)
    }
    if (proc.signal) {
      failureDetails.push(`[lsp-signal] Process terminated by signal ${proc.signal}`)
    }
    if (typeof proc.status === "number" && proc.status !== 0) {
      failureDetails.push(`[lsp-exit-${proc.status}] effect-tsgo exited with status ${proc.status}`)
    }
    const stderrText = (proc.stderr ?? "").trim()
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
  }).pipe(
    Effect.catch((cause): Effect.Effect<LspDiagnosticsReport> =>
      Effect.succeed(makeLspExceptionReport(cause)),
    ),
    Effect.catchDefect((defect): Effect.Effect<LspDiagnosticsReport> =>
      Effect.succeed(makeLspExceptionReport(defect)),
    ),
  )

const evaluateOverlaysDiagnostics = (
  root: string,
  overlays: Record<string, string>,
  file: string | undefined,
  project: string | undefined,
): LspDiagnosticsReport => {
  const escapedBoundaryPaths: Array<{ readonly file: string; readonly message: string }> = []
  for (const k of Object.keys(overlays)) {
    const absKey = path.isAbsolute(k) ? path.resolve(k) : path.resolve(root, k)
    if (!isPathInsideRoot(root, absKey)) {
      escapedBoundaryPaths.push({
        file: k,
        message: `Overlay path '${k}' escapes repository root.`,
      })
    }
  }
  if (file !== undefined && file.length > 0) {
    const absFile = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file)
    if (!isPathInsideRoot(root, absFile)) {
      escapedBoundaryPaths.push({
        file,
        message: `File path '${file}' escapes repository root.`,
      })
    }
  }
  if (project !== undefined && project.length > 0) {
    const absProject = path.isAbsolute(project)
      ? path.resolve(project)
      : path.resolve(root, project)
    if (!isPathInsideRoot(root, absProject)) {
      escapedBoundaryPaths.push({
        file: project,
        message: `Project path '${project}' escapes repository root.`,
      })
    }
  }
  if (escapedBoundaryPaths.length > 0) {
    const escapeDiags = escapedBoundaryPaths.map((entry) => ({
      file: entry.file,
      line: 1,
      column: 1,
      code: "PATH_TRAVERSAL",
      severity: "error" as const,
      message: entry.message,
    }))
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
  const targetRelFile = file !== undefined && file.trim().length > 0 ? toRootRelPosix(file) : undefined
  const matchesTargetFile = (candidate: string): boolean => {
    if (targetRelFile === undefined) return true
    return toRootRelPosix(candidate) === targetRelFile
  }
  const compilableKeys = Object.keys(overlays).filter(
    (k) => (k.endsWith(".ts") || k.endsWith(".tsx")) && !k.endsWith(".d.ts"),
  )
  const matchedKeys =
    targetRelFile !== undefined ? compilableKeys.filter(matchesTargetFile) : compilableKeys
  const session = getOrCreateWarmProgramSession(root)
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
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        if (overlays !== undefined && Object.keys(overlays).length > 0) {
          return yield* Effect.try({
            try: () => evaluateOverlaysDiagnostics(root, overlays, file, project),
            catch: toLspExecutionError,
          }).pipe(
            Effect.catch((cause) => Effect.succeed(makeLspExceptionReport(cause))),
            Effect.catchDefect((defect) => Effect.succeed(makeLspExceptionReport(defect))),
          )
        }
        if (options?.lspDiagnosticsRunner !== undefined) {
          const runner = options.lspDiagnosticsRunner
          return yield* Effect.try({
            try: () => runner({ file, project }),
            catch: toLspExecutionError,
          }).pipe(
            Effect.catch((cause) => Effect.succeed(makeLspExceptionReport(cause))),
            Effect.catchDefect((defect) => Effect.succeed(makeLspExceptionReport(defect))),
          )
        }
        return yield* runDefaultLspDiagnostics(root, { file, project })
      }),
  },
  {
    name: McpToolName.make("harness_telemetry_report"),
    description:
      "Generate a session observability and tool-usage health report across CLI, hooks, and MCP tools",
    inputSchema: TelemetryReportInputSchema,
    execute: (args) =>
      Effect.gen(function* () {
        const { format, cumulative } = yield* decodeTelemetryReportInput(args)
        const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
        const events = readTelemetryEvents(root)
        const frictionEvents = readFrictionEvents(root)
        const report = buildSessionReport({
          events,
          frictionEvents,
          ...(cumulative === true ? { cumulative: true } : {}),
        })
        if (format === "markdown") {
          return { markdown: renderSessionReportMarkdown(report), report }
        }
        return report
      }),
  },
]
