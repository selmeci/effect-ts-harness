import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Option, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
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
  readGraphHeadMeta,
  resolveGitHeadState,
  saveGraphSnapshot,
  extractWorkspaceTypeAwareGraph,
  writeGraphHeadMeta,
} from "@harness/graph"
import type { GovernanceDocReference } from "@harness/decision"

export const McpToolName = Schema.NonEmptyString.pipe(Schema.brand("McpToolName"))
export type McpToolName = typeof McpToolName.Type

export const McpToolInputName = Schema.String.pipe(Schema.brand("McpToolInputName"))
export type McpToolInputName = typeof McpToolInputName.Type

export class UnknownToolError extends Schema.TaggedError<UnknownToolError>()("UnknownToolError", {
  toolName: McpToolInputName,
}) {}

export class ProjectPathEscapeError extends Schema.TaggedError<ProjectPathEscapeError>()(
  "ProjectPathEscapeError",
  {
    projectPath: Schema.String,
    repoRoot: Schema.String,
    message: Schema.String,
  },
) {}

export type McpToolExecutionError =
  | UnknownToolError
  | Schema.SchemaError
  | ProjectPathEscapeError
  | ConceptLatticeCycleError
  | GraphInferenceError
  | GraphRewriteError
  | GraphProjectorError

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
  readonly repoRoot?: string
  readonly governanceDocs?: ReadonlyArray<GovernanceDocReference>
  readonly lspDiagnosticsRunner?: (input: {
    readonly file?: string | undefined
    readonly project?: string | undefined
  }) => LspDiagnosticsReport
}

export const findRepoRoot = (startDir: string): string => {
  let curr = path.resolve(startDir)
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = path.dirname(curr)
  }
  return startDir
}

const SERVER_REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)))

const decodeActiveWorkspace = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ repoRoot: Schema.String })),
)

export const resolveDefaultRepoRoot = (args?: Readonly<Record<string, unknown>>): string => {
  const rawRepoRoot = args?.["repoRoot"]
  if (typeof rawRepoRoot === "string" && rawRepoRoot.length > 0) {
    return findRepoRoot(rawRepoRoot)
  }
  const rawFile = args?.["file"]
  const rawFilePath = args?.["filePath"]
  const rawPaths = args?.["paths"]
  const rawFileCandidate =
    typeof rawFile === "string"
      ? rawFile
      : typeof rawFilePath === "string"
        ? rawFilePath
        : Array.isArray(rawPaths) && typeof rawPaths[0] === "string"
          ? rawPaths[0]
          : undefined
  const rawProject = args?.["project"]
  const candidate =
    typeof rawFileCandidate === "string" && path.isAbsolute(rawFileCandidate)
      ? rawFileCandidate
      : typeof rawProject === "string" && path.isAbsolute(rawProject)
        ? rawProject
        : undefined
  if (candidate !== undefined) {
    const candidateRoot = findRepoRoot(path.dirname(candidate))
    if (fs.existsSync(path.join(candidateRoot, "pnpm-workspace.yaml"))) {
      return candidateRoot
    }
  }
  const cwdRoot = findRepoRoot(process.cwd())
  if (cwdRoot !== SERVER_REPO_ROOT) {
    return cwdRoot
  }
  if (process.env.VITEST === undefined) {
    const activeWorkspacePath = path.join(SERVER_REPO_ROOT, ".harness", "active-workspace.json")
    if (fs.existsSync(activeWorkspacePath)) {
      const resolvedActiveRoot = Effect.runSync(
        Effect.try(() => {
          const raw = fs.readFileSync(activeWorkspacePath, "utf-8")
          const parsed = Option.getOrUndefined(decodeActiveWorkspace(raw))
          return parsed !== undefined && fs.existsSync(parsed.repoRoot)
            ? parsed.repoRoot
            : undefined
        }).pipe(Effect.orElseSucceed(() => undefined)),
      )
      if (resolvedActiveRoot !== undefined) {
        return resolvedActiveRoot
      }
    }
  }
  return SERVER_REPO_ROOT
}

const buildEmptyHarnessGraph = (): HarnessGraph =>
  buildHarnessGraph({
    fns: [],
    services: [],
    layers: [],
    errors: [],
    tests: [],
    patternDocs: [],
  })

const selectSnapshotPath = (
  root: string,
  verifySnap: string,
  planSnap: string,
  verifyExists: boolean,
  planExists: boolean,
): string | undefined => {
  if (verifyExists && planExists) {
    const verifyMtime = fs.statSync(verifySnap).mtimeMs
    const planMtime = fs.statSync(planSnap).mtimeMs
    return planMtime > verifyMtime ? planSnap : verifySnap
  }
  if (verifyExists) {
    return verifySnap
  }
  if (planExists) {
    return planSnap
  }
  return undefined
}

export const resolveGraph = (
  options?: ServerOptions,
  args?: Readonly<Record<string, unknown>>,
): Effect.Effect<HarnessGraph> => {
  if (options?.graph) {
    return Effect.succeed(options.graph)
  }
  return Effect.gen(function* () {
    const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
    let snapshotPath = options?.snapshotPath
    if (!snapshotPath) {
      const verifySnap = path.join(root, ".harness", "graph-snapshot.json")
      const planSnap = path.join(root, ".harness", "plan-graph-snapshot.json")
      const verifyExists = fs.existsSync(verifySnap)
      const planExists = fs.existsSync(planSnap)
      if (verifyExists) {
        const recordedMeta = readGraphHeadMeta(root)
        const headState = resolveGitHeadState(root)
        if (
          recordedMeta !== null &&
          headState.headSha !== null &&
          recordedMeta.headSha !== headState.headSha
        ) {
          const freshGraph = yield* extractWorkspaceTypeAwareGraph(root)
          saveGraphSnapshot(freshGraph, verifySnap)
          writeGraphHeadMeta(root, headState)
          return freshGraph
        }
      }
      snapshotPath = selectSnapshotPath(root, verifySnap, planSnap, verifyExists, planExists)
    }
    if (snapshotPath && fs.existsSync(snapshotPath)) {
      return yield* loadGraphSnapshotEffect(snapshotPath).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            `Failed to load graph snapshot from '${snapshotPath}' [${error.reason}]: ${error.message}`,
          ),
        ),
        Effect.orElseSucceed(buildEmptyHarnessGraph),
      )
    }
    return buildEmptyHarnessGraph()
  }).pipe(
    Effect.catchDefect((defect) =>
      Effect.gen(function* () {
        const message = defect instanceof Error ? defect.message : String(defect)
        process.stderr.write(`[harness-mcp] Unexpected defect resolving graph: ${message}\n`)
        yield* Effect.logWarning(`Unexpected defect resolving graph: ${message}`)
        return buildEmptyHarnessGraph()
      }),
    ),
  )
}

export const isPathInsideRoot = (rootDir: string, candidatePath: string): boolean => {
  const logicalRoot = path.resolve(rootDir)
  const logicalCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(logicalRoot, candidatePath)
  const rel = path.relative(logicalRoot, logicalCandidate)
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    return false
  }
  if (fs.existsSync(logicalRoot)) {
    let checkPath = logicalCandidate
    while (!fs.existsSync(checkPath) && checkPath !== logicalRoot) {
      const parent = path.dirname(checkPath)
      if (parent === checkPath) break
      checkPath = parent
    }
    if (fs.existsSync(checkPath)) {
      const checkRel = path.relative(logicalRoot, checkPath)
      if (!checkRel.startsWith("..") && !path.isAbsolute(checkRel)) {
        const contained = Effect.runSync(
          Effect.try({
            try: () => {
              const realRoot = fs.realpathSync.native(logicalRoot)
              const realCheck = fs.realpathSync.native(checkPath)
              const realRel = path.relative(realRoot, realCheck)
              return !(realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel)))
            },
            catch: () => false,
          }),
        )
        if (!contained) {
          return false
        }
      }
    }
  }
  return true
}

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
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
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

export const normalizeProjectPath = (
  repoRoot: string,
  rawProject: string,
): Effect.Effect<string, ProjectPathEscapeError> =>
  normalizeProjectPathEffect(repoRoot, rawProject)

const extractJsonSchemaProperties = (raw: unknown): Record<string, object> | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined
  }
  const props: Record<string, object> = {}
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "object" && val !== null) {
      props[key] = val
    }
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

export const recordMcpToolTelemetry = (
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
  durationMs: number,
  options?: ServerOptions,
): void => {
  if (options?.repoRoot === undefined && process.env.VITEST !== undefined) {
    return
  }
  const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
  const category: TelemetryCategory = match(toolName)
    .with(
      "harness_ontology_why",
      "harness_ontology_impact",
      "harness_ontology_check",
      () => "ontology" as const,
    )
    .with("harness_route", () => "routing" as const)
    .with("harness_lsp_diagnostics", () => "gate" as const)
    .otherwise(() => "graph_query" as const)

  const engineSource: TelemetryEngineSource = match(toolName)
    .with("harness_gq_query", () =>
      typeof result === "object" &&
      result !== null &&
      "source" in result &&
      result.source === "omnigraph"
        ? ("omnigraph" as const)
        : ("memory-fallback" as const),
    )
    .with("harness_route", "harness_ontology_check", () => "decision-model" as const)
    .otherwise(() => "local" as const)

  const outcome: TelemetryOutcome =
    toolName === "harness_gq_query" && engineSource === "memory-fallback"
      ? "fallback"
      : toolName === "harness_lsp_diagnostics" &&
          typeof result === "object" &&
          result !== null &&
          "clean" in result &&
          result.clean === false
        ? "fail"
        : "ok"

  appendTelemetryEvent(root, {
    surface: "mcp",
    category,
    toolName,
    outcome,
    durationMs,
    engineSource,
  })
}
