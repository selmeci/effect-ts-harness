import * as path from "node:path"
import { Effect, Schema } from "effect"
import { WorkflowTimeoutMs } from "@harness/contract"
import { createTypeScriptProgramSession, evaluateOverlayDiagnostics } from "@harness/graph"
import {
  buildSessionReport,
  readFrictionEvents,
  readTelemetryEvents,
  renderSessionReportMarkdown,
} from "@harness/gates"
import { nodeSyncHostIo } from "@harness/infra"
import {
  findRepoRoot,
  isPathInsideRoot,
  type LspDiagnosticsReport,
  McpToolName,
  type McpToolPluginDescriptor,
  ProjectPathEscapeError,
  resolveContainedRepoRoot,
  type ServerOptions,
} from "./mcp-helpers.js"
import { hasValidWorkspaceRootMarker } from "./mcp-repo-root.js"
import type { LspSessionCache } from "./lsp-session-cache.js"
import {
  extractTs2484CycleHint,
  handleLspFailure,
  LspDiagnostics,
  type LspDiagnosticsExecutionOptions,
  makeLspExceptionReport,
  resolveLspWatchdogTimeoutMs,
  runLspDiagnosticsWithWatchdog,
  toLspExecutionError,
  toLspTimeoutDiagnosticsReport,
} from "./lsp-watchdog.js"

export type { LspDiagnosticsExecutionOptions, LspDiagnosticsReport }
export {
  extractTs2484CycleHint,
  LspDiagnostics,
  resolveLspWatchdogTimeoutMs,
  runLspDiagnosticsWithWatchdog,
}

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
  watchdogTimeoutMs: Schema.optional(
    WorkflowTimeoutMs.annotate({
      description: "Optional subprocess watchdog timeout in milliseconds (defaults to 45000)",
    }),
  ),
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
    readonly watchdogTimeoutMs?: number | undefined
  },
  execOptions?: LspDiagnosticsExecutionOptions,
): Effect.Effect<LspDiagnosticsReport, ProjectPathEscapeError> =>
  LspDiagnostics.run(repoRoot, input, execOptions).pipe(
    Effect.catchTag("LspDiagnosticsTimeoutError", (err) =>
      Effect.succeed(toLspTimeoutDiagnosticsReport(err, repoRoot)),
    ),
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
  const summary = {
    filesChecked: matchedKeys.length,
    filesWithoutPlugin: 0,
    totalFiles: Object.keys(overlays).length,
    errors,
    warnings,
    messages: filteredDiags.length,
  }
  if (matchedKeys.length > 0 && errors === 0 && warnings === 0) {
    return {
      clean: true,
      diagnostics: filteredDiags,
      summary,
    }
  }
  return {
    clean: false,
    diagnostics: filteredDiags,
    summary,
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
        const watchdogTimeoutMs = typedArgs.watchdogTimeoutMs ?? options?.lspWatchdogTimeoutMs
        return yield* LspDiagnostics.run(
          root,
          { file, project, ...(watchdogTimeoutMs !== undefined ? { watchdogTimeoutMs } : {}) },
          {
            cache: lspSessionCache,
            execTsgo: options?.lspTsgoExecutor,
            ...(watchdogTimeoutMs !== undefined ? { watchdogTimeoutMs } : {}),
          },
        ).pipe(
          Effect.catchTag("LspDiagnosticsTimeoutError", (err) =>
            Effect.succeed(toLspTimeoutDiagnosticsReport(err, root)),
          ),
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
