import * as path from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  CANONICAL_MCP_TOOL_NAMES,
  DocTreePathError,
  EmbeddingProviderError,
  type DaemonProtocolMismatchError,
  GitDiffErrorReason,
  GitDiffExecutionError,
  InvalidReviewRouteInputError,
  McpToolInputName,
  McpToolName,
  type ReviewTimeoutMillis,
  toMcpToolInputName,
  UnknownToolError,
  type WorkflowStoreUnavailableError,
  type WorkspaceFsError,
} from "@harness/contract"
import type { EmbeddingCachePort, EmbeddingClient, WorkspaceFs } from "@harness/service"
import {
  appendTelemetryEvent,
  type TelemetryCategory,
  type TelemetryEngineSource,
  type TelemetryOutcome,
} from "@harness/gates"
import {
  buildHarnessGraph,
  type ConceptLatticeCycleError,
  type GraphInferenceError,
  type GraphProjectorError,
  type GraphRewriteError,
  type HarnessGraph,
  loadGraphSnapshotEffect,
  type OmnigraphLoadError,
  type OmnigraphSync,
  readGraphHeadMeta,
  resolveGitHeadState,
  saveGraphSnapshot,
  extractWorkspaceTypeAwareGraph,
  writeGraphHeadMeta,
} from "@harness/graph"
import type { GovernanceDocReference } from "@harness/decision"
import { nodeSyncHostIo, resolveHarnessStateDir } from "@harness/infra"
import type {
  LspSessionCache,
  LspSessionCacheOptions,
  LspTsgoExecutor,
} from "./lsp-session-cache.js"
import {
  findRepoRoot,
  hasIntermediateRepoBoundary,
  hasWorkspaceMarker,
  isPathInsideRoot,
  ProjectPathEscapeError,
  resolveContainedRepoRoot,
  resolveDefaultRepoRoot,
  SERVER_REPO_ROOT,
} from "./mcp-repo-root.js"
import { attachServerCloseRuntimeDisposal, formatMcpToolExit } from "./mcp-runtime-helpers.js"

export {
  attachServerCloseRuntimeDisposal,
  CANONICAL_MCP_TOOL_NAMES,
  findRepoRoot,
  formatMcpToolExit,
  GitDiffErrorReason,
  GitDiffExecutionError,
  hasIntermediateRepoBoundary,
  hasWorkspaceMarker,
  isPathInsideRoot,
  McpToolInputName,
  McpToolName,
  ProjectPathEscapeError,
  resolveContainedRepoRoot,
  resolveDefaultRepoRoot,
  SERVER_REPO_ROOT,
  toMcpToolInputName,
  UnknownToolError,
}

export type McpToolExecutionError =
  | UnknownToolError
  | Schema.SchemaError
  | ProjectPathEscapeError
  | GitDiffExecutionError
  | InvalidReviewRouteInputError
  | ConceptLatticeCycleError
  | GraphInferenceError
  | GraphRewriteError
  | GraphProjectorError
  | OmnigraphLoadError
  | DocTreePathError
  | EmbeddingProviderError
  | WorkflowStoreUnavailableError
  | WorkspaceFsError
  | DaemonProtocolMismatchError

export type McpToolInputSchema = Schema.Decoder<Readonly<Record<string, unknown>>> & Schema.Top

export interface McpToolPluginDescriptor {
  readonly name: McpToolName
  readonly description: string
  readonly inputSchema: McpToolInputSchema
  readonly execute: (
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, McpToolExecutionError>
}

export interface LspDiagnosticsReport {
  readonly clean: boolean
  readonly diagnostics: ReadonlyArray<unknown>
  readonly summary: {
    readonly filesChecked: number
    readonly filesWithoutPlugin: number
    readonly totalFiles: number
    readonly errors: number
    readonly warnings: number
    readonly messages: number
  }
}

export interface ServerOptions {
  readonly graph?: HarnessGraph
  readonly snapshotPath?: string
  readonly decisionLayer?: Layer.Layer<DecisionModel.DecisionModel>
  readonly embeddingClientLayer?: Layer.Layer<EmbeddingClient>
  readonly embeddingCacheLayer?: Layer.Layer<EmbeddingCachePort>
  readonly workspaceFsLayer?: Layer.Layer<WorkspaceFs>
  readonly omnigraphSyncLayer?: Layer.Layer<OmnigraphSync>
  readonly extraLayer?: Layer.Layer<never>
  readonly repoRoot?: string
  readonly reviewRouteTimeoutMs?: ReviewTimeoutMillis | undefined
  readonly governanceDocs?: ReadonlyArray<GovernanceDocReference>
  readonly skipOmnigraphSpawn?: boolean | undefined
  readonly skipTelemetry?: boolean | undefined
  readonly skipActiveWorkspaceLookup?: boolean | undefined
  readonly lspDiagnosticsRunner?: (input: {
    readonly file?: string | undefined
    readonly project?: string | undefined
  }) => LspDiagnosticsReport
  readonly lspSessionCache?: LspSessionCache | undefined
  readonly lspSessionCacheOptions?: LspSessionCacheOptions | undefined
  readonly lspTsgoExecutor?: LspTsgoExecutor | undefined
}

export const shouldSuppressLiveMcpTestSideEffects = (
  targetRepoRoot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean =>
  (env["HARNESS_DISABLE_LIVE_TELEMETRY"] === "1" ||
    env["HARNESS_TEST_ISOLATION"] === "1" ||
    env["VITEST"] === "true" ||
    env["NODE_ENV"] === "test") &&
  (env["HARNESS_STATE_DIR"] === undefined || env["HARNESS_STATE_DIR"].trim() === "") &&
  isPathInsideRoot(SERVER_REPO_ROOT, targetRepoRoot)

const buildEmptyHarnessGraph = (): HarnessGraph =>
  buildHarnessGraph({ fns: [], services: [], layers: [], errors: [], tests: [], patternDocs: [] })

const selectSnapshotPath = (
  verifySnap: string,
  planSnap: string,
  verifyExists: boolean,
  planExists: boolean,
): string | undefined => {
  if (verifyExists && planExists) {
    return (nodeSyncHostIo.statMtimeMsSync(planSnap) ?? 0) >
      (nodeSyncHostIo.statMtimeMsSync(verifySnap) ?? 0)
      ? planSnap
      : verifySnap
  }
  return verifyExists ? verifySnap : planExists ? planSnap : undefined
}

export interface GraphResolutionStatus {
  readonly graph: HarnessGraph
  readonly degraded: boolean
  readonly degradedReason?: string | undefined
  readonly evaluationError?: string | undefined
}

export const resolveGraphWithStatus = (
  options?: ServerOptions,
  args?: Readonly<Record<string, unknown>>,
): Effect.Effect<GraphResolutionStatus> => {
  if (options?.graph) {
    return Effect.succeed({ graph: options.graph, degraded: false })
  }
  return Effect.gen(function* () {
    const root = options?.repoRoot ?? resolveDefaultRepoRoot(args, options)
    let snapshotPath = options?.snapshotPath
    let stalenessDegradedReason: string | undefined = undefined
    let stalenessEvaluationError: string | undefined = undefined
    if (!snapshotPath) {
      const stateDirOrError = match(Result.try(() => resolveHarnessStateDir(root)))
        .with({ _tag: "Success" }, ({ success }) => ({ stateDir: success, error: undefined }))
        .with({ _tag: "Failure" }, ({ failure }) => ({
          stateDir: undefined,
          error: `Failed to resolve harness state directory for '${root}': ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
        }))
        .exhaustive()
      if (stateDirOrError.error !== undefined || stateDirOrError.stateDir === undefined) {
        const evaluationError = stateDirOrError.error ?? "Failed to resolve harness state directory"
        process.stderr.write(`[harness-mcp] ${evaluationError}\n`)
        return {
          graph: buildEmptyHarnessGraph(),
          degraded: true,
          degradedReason: "graph-state-io-error",
          evaluationError,
        }
      }
      const stateDir = stateDirOrError.stateDir
      const verifySnap = path.join(stateDir, "graph-snapshot.json")
      const planSnap = path.join(stateDir, "plan-graph-snapshot.json")
      const verifyExists = nodeSyncHostIo.existsSync(verifySnap)
      const planExists = nodeSyncHostIo.existsSync(planSnap)
      if (verifyExists) {
        const recordedMeta = readGraphHeadMeta(root, nodeSyncHostIo)
        const headState = resolveGitHeadState(root, nodeSyncHostIo)
        if (recordedMeta !== null) {
          if (headState.headSha === null) {
            stalenessDegradedReason = "git-head-unavailable"
            stalenessEvaluationError =
              "Git HEAD SHA is unavailable; cannot verify graph snapshot freshness"
          }
          if (headState.headSha !== null && recordedMeta.headSha !== headState.headSha) {
            const freshGraph = yield* extractWorkspaceTypeAwareGraph(root, nodeSyncHostIo)
            const saveError = match(
              Result.try(() => saveGraphSnapshot(freshGraph, verifySnap, nodeSyncHostIo)),
            )
              .with({ _tag: "Success" }, () => undefined)
              .with(
                { _tag: "Failure" },
                ({ failure }) =>
                  `Failed to persist graph snapshot in '${root}': ${
                    failure instanceof Error ? failure.message : String(failure)
                  }`,
              )
              .exhaustive()
            if (saveError !== undefined) {
              process.stderr.write(`[harness-mcp] ${saveError}\n`)
              return {
                graph: buildEmptyHarnessGraph(),
                degraded: true,
                degradedReason: "graph-state-io-error",
                evaluationError: saveError,
              }
            }
            const savedMeta = writeGraphHeadMeta(root, nodeSyncHostIo, headState)
            if (
              savedMeta === null &&
              (headState.headSha !== null || headState.gitBranch !== null)
            ) {
              process.stderr.write(
                `[harness-mcp] Warning: failed to persist graph-head.json in '${root}'\n`,
              )
            }
            return { graph: freshGraph, degraded: false }
          }
        }
      }
      snapshotPath = selectSnapshotPath(verifySnap, planSnap, verifyExists, planExists)
    }
    if (snapshotPath && nodeSyncHostIo.existsSync(snapshotPath)) {
      return yield* loadGraphSnapshotEffect(snapshotPath, nodeSyncHostIo).pipe(
        Effect.map((graph): GraphResolutionStatus =>
          stalenessDegradedReason !== undefined
            ? {
                graph,
                degraded: true,
                degradedReason: stalenessDegradedReason,
                evaluationError: stalenessEvaluationError,
              }
            : { graph, degraded: false },
        ),
        Effect.catchTag("GraphSnapshotError", (error) => {
          const evaluationError = `Failed to load graph snapshot from '${snapshotPath}' [${error.reason}]: ${error.message}`
          process.stderr.write(`[harness-mcp] ${evaluationError}\n`)
          return Effect.succeed<GraphResolutionStatus>({
            graph: buildEmptyHarnessGraph(),
            degraded: true,
            degradedReason: "corrupt-graph-snapshot",
            evaluationError,
          })
        }),
      )
    }
    return {
      graph: buildEmptyHarnessGraph(),
      degraded: true,
      degradedReason: "missing-graph-snapshot",
      evaluationError: `Graph snapshot file is missing in '${root}'`,
    }
  }).pipe(
    Effect.catchDefect((defect) => {
      const message = defect instanceof Error ? defect.message : String(defect)
      process.stderr.write(`[harness-mcp] Unexpected defect resolving graph: ${message}\n`)
      return Effect.die(defect)
    }),
  )
}

export const graphStatusMeta = (
  graphStatus: GraphResolutionStatus,
): {
  readonly degraded: boolean
  readonly degradedReason?: string
  readonly evaluationError?: string
} => ({
  degraded: graphStatus.degraded,
  ...(graphStatus.degradedReason !== undefined
    ? { degradedReason: graphStatus.degradedReason }
    : {}),
  ...(graphStatus.evaluationError !== undefined
    ? { evaluationError: graphStatus.evaluationError }
    : {}),
})

export const normalizeProjectPathEffect = (
  repoRoot: string,
  rawProject: string,
): Effect.Effect<string, ProjectPathEscapeError> => {
  const resolved = path.isAbsolute(rawProject)
    ? path.resolve(rawProject)
    : path.resolve(repoRoot, rawProject)
  if (!isPathInsideRoot(repoRoot, resolved)) {
    return Effect.fail(
      new ProjectPathEscapeError({
        projectPath: rawProject,
        repoRoot,
        message: `Project path '${rawProject}' escapes repository root '${repoRoot}'.`,
      }),
    )
  }
  if (nodeSyncHostIo.existsSync(resolved) && nodeSyncHostIo.isDirectorySync(resolved)) {
    const joined = path.join(resolved, "tsconfig.json")
    if (!isPathInsideRoot(repoRoot, joined)) {
      return Effect.fail(
        new ProjectPathEscapeError({
          projectPath: joined,
          repoRoot,
          message: `Project path '${joined}' escapes repository root '${repoRoot}'.`,
        }),
      )
    }
    return Effect.succeed(joined)
  }
  return Effect.succeed(resolved)
}

export const normalizeProjectPath = normalizeProjectPathEffect

const extractJsonSchemaProperties = (raw: unknown): Record<string, object> | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const props: Record<string, object> = {}
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "object" && val !== null) props[key] = val
  }
  return props
}

export const toMcpToolInputJsonSchema = (inputSchema: McpToolInputSchema) => {
  const doc = Schema.toJsonSchemaDocument(inputSchema)
  const properties = extractJsonSchemaProperties(doc.schema["properties"])
  const rawRequired = doc.schema["required"]
  const required =
    Array.isArray(rawRequired) &&
    rawRequired.every((item): item is string => typeof item === "string")
      ? rawRequired
      : undefined
  const hasDefinitions = Object.keys(doc.definitions).length > 0
  return {
    ...doc.schema,
    type: "object" as const,
    ...(properties !== undefined ? { properties } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(hasDefinitions ? { $defs: doc.definitions } : {}),
  }
}

const normalizeDegradedReason = (raw: string): string => raw.replace(/\s+/g, " ").trim()

const extractNonEmptyReason = (obj: object): string | undefined => {
  const rawReason = Reflect.get(obj, "degradedReason")
  if (typeof rawReason === "string") {
    const normalized = normalizeDegradedReason(rawReason)
    if (normalized.length > 0) return normalized
  }
  return undefined
}

const extractDegradedReason = (result: unknown): string | undefined => {
  if (typeof result !== "object" || result === null) return undefined
  const topReason = extractNonEmptyReason(result)
  if (topReason !== undefined) return topReason
  const plan = Reflect.get(result, "plan")
  if (typeof plan === "object" && plan !== null) {
    const planReason = extractNonEmptyReason(plan)
    if (planReason !== undefined) return planReason
  }
  if (Reflect.get(result, "degraded") === true) {
    return "degraded"
  }
  return undefined
}

const formatLspFailDetail = (
  toolName: string,
  outcome: TelemetryOutcome,
  result: unknown,
): string | undefined => {
  const isFailOutcome = match(outcome)
    .with("fail", () => true)
    .with("ok", "fallback", "ask", "deny", () => false)
    .exhaustive()
  if (
    toolName !== "harness_lsp_diagnostics" ||
    !isFailOutcome ||
    typeof result !== "object" ||
    result === null
  ) {
    return undefined
  }
  const summary = Reflect.get(result, "summary")
  if (typeof summary !== "object" || summary === null) return undefined
  const errors = Reflect.get(summary, "errors")
  const warnings = Reflect.get(summary, "warnings")
  return `errors=${String(typeof errors === "number" ? errors : 0)};warnings=${String(typeof warnings === "number" ? warnings : 0)}`
}

export const recordMcpToolTelemetry = (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
  durationMs: number,
  options?: ServerOptions,
): void => {
  if (
    options?.skipTelemetry === true ||
    (options?.repoRoot === undefined && options?.skipOmnigraphSpawn === true)
  ) {
    return
  }
  const boundaryRoot = options?.repoRoot ?? resolveDefaultRepoRoot(args, options)
  const rawArgRepoRoot = args["repoRoot"]
  let root = boundaryRoot
  if (typeof rawArgRepoRoot === "string" && rawArgRepoRoot.trim().length > 0) {
    const trimmed = rawArgRepoRoot.trim()
    const resolvedArg = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(boundaryRoot, trimmed)
    root =
      isPathInsideRoot(boundaryRoot, resolvedArg) &&
      !hasIntermediateRepoBoundary(boundaryRoot, resolvedArg)
        ? path.resolve(boundaryRoot)
        : resolvedArg
  }
  if (shouldSuppressLiveMcpTestSideEffects(root)) {
    return
  }
  const category: TelemetryCategory = match(toolName)
    .with(
      "harness_ontology_why",
      "harness_ontology_impact",
      "harness_ontology_check",
      () => "ontology" as const,
    )
    .with("harness_route", "harness_review_route", () => "routing" as const)
    .with("harness_lsp_diagnostics", () => "gate" as const)
    .otherwise(() => "graph_query" as const)

  const engineSource: TelemetryEngineSource = match(toolName)
    .with("harness_gq_query", () =>
      match(result)
        .with({ source: "omnigraph" }, () => "omnigraph" as const)
        .with({ source: "memory-fallback" }, () => "memory-fallback" as const)
        .otherwise(() => "memory-fallback" as const),
    )
    .with("harness_search_knowledge", () =>
      match(result)
        .with(
          { retrievalMode: "hybrid-rrf" },
          { retrievalMode: "bm25-only" },
          () => "omnigraph" as const,
        )
        .with({ retrievalMode: "lexical-fallback" }, () => "memory-fallback" as const)
        .otherwise(() => "memory-fallback" as const),
    )
    .with(
      "harness_route",
      "harness_review_route",
      "harness_ontology_check",
      () => "decision-model" as const,
    )
    .otherwise(() => "local" as const)

  const degradedReason = extractDegradedReason(result)
  const isCleanFalseFail =
    (toolName === "harness_lsp_diagnostics" || toolName === "harness_ontology_check") &&
    typeof result === "object" &&
    result !== null &&
    "clean" in result &&
    result.clean === false
  const isMemoryFallback = match(engineSource)
    .with("memory-fallback", () => true)
    .with("omnigraph", "local", "decision-model", () => false)
    .exhaustive()
  const outcome: TelemetryOutcome =
    degradedReason !== undefined
      ? "fallback"
      : (toolName === "harness_gq_query" || toolName === "harness_search_knowledge") &&
          isMemoryFallback
        ? "fallback"
        : isCleanFalseFail
          ? "fail"
          : "ok"

  const detail =
    degradedReason !== undefined
      ? `degraded=${degradedReason.slice(0, 151)}`
      : formatLspFailDetail(toolName, outcome, result)

  appendTelemetryEvent(
    root,
    {
      surface: "mcp",
      category,
      toolName,
      outcome,
      durationMs,
      engineSource,
      ...(detail !== undefined ? { detail } : {}),
    },
    nodeSyncHostIo,
  )
}
