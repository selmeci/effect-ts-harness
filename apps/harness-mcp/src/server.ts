import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { Effect, Layer, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  buildHarnessGraph,
  ConfidenceMillis,
  decideGraphInference,
  type EffectFnNode,
  type EntityNode,
  extractWorkspaceTypeAwareGraph,
  findCallees,
  findCallers,
  findTestsReaching,
  getNodeKey,
  HARNESS_GQ_QUERY_NAMES,
  type HarnessGqQueryName,
  type HarnessGraph,
  invokeOmnigraphNamedQuery,
  isEntityNode,
  loadGraphSnapshot,
  NodeKey,
  OmnigraphSync,
  PageRankScoreMillis,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
  readGraphHeadMeta,
  resolveGitHeadState,
  resolveNode,
  saveGraphSnapshot,
  type SemanticEdgePriors,
  structuralSearch,
  writeGraphHeadMeta,
} from "@harness/graph"
import {
  CandidateSymbolKey,
  decideOntologyInvariants,
  evaluateHoleCandidatePrior,
  evaluateOntologyConflicts,
  extractOntologyConflictPairs,
  type GovernanceDocReference,
  loadGovernanceDocsFromDisk,
  LocalDecisionModel,
  ProposedRoleName,
  routeStep,
} from "@harness/decision"
export {
  decideOmnigraphReconcile,
  deriveRepoOmnigraphPort,
  readGraphHeadMeta,
  resolveCanonicalRepoRoot,
  resolveGitHeadState,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
  writeGraphHeadMeta,
} from "@harness/gates"
import {
  appendTelemetryEvent,
  buildSessionReport,
  readFrictionEvents,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  type TelemetryCategory,
  type TelemetryEngineSource,
  type TelemetryOutcome,
} from "@harness/gates"

export class UnknownToolError extends Schema.TaggedError<UnknownToolError>()("UnknownToolError", {
  toolName: Schema.String,
}) {}

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

const findRepoRoot = (startDir: string): string => {
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

if (!("iterations" in globalThis)) {
  Object.assign(globalThis, { iterations: 0 })
}

const resolveDefaultRepoRoot = (args?: Record<string, unknown>): string => {
  if (typeof args?.repoRoot === "string" && args.repoRoot.length > 0) {
    return findRepoRoot(args.repoRoot)
  }
  const candidate =
    typeof args?.file === "string" && path.isAbsolute(args.file)
      ? args.file
      : typeof args?.project === "string" && path.isAbsolute(args.project)
        ? args.project
        : undefined
  if (candidate !== undefined) {
    return findRepoRoot(path.dirname(candidate))
  }
  const cwdRoot = findRepoRoot(process.cwd())
  if (cwdRoot !== SERVER_REPO_ROOT) {
    return cwdRoot
  }
  if (process.env.VITEST === undefined) {
    const activeWorkspacePath = path.join(SERVER_REPO_ROOT, ".harness", "active-workspace.json")
    if (fs.existsSync(activeWorkspacePath)) {
      const decodeActiveWorkspace = Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ repoRoot: Schema.String })),
      )
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

const resolveGraph = (
  options?: ServerOptions,
  args?: Record<string, unknown>,
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
      if (verifyExists && planExists) {
        const verifyMtime = fs.statSync(verifySnap).mtimeMs
        const planMtime = fs.statSync(planSnap).mtimeMs
        snapshotPath = planMtime > verifyMtime ? planSnap : verifySnap
      } else if (verifyExists) {
        snapshotPath = verifySnap
      } else if (planExists) {
        snapshotPath = planSnap
      }
    }
    if (snapshotPath && fs.existsSync(snapshotPath)) {
      return loadGraphSnapshot(snapshotPath)
    }
    return buildHarnessGraph({
      fns: [],
      services: [],
      layers: [],
      errors: [],
      tests: [],
      patternDocs: [],
    })
  }).pipe(
    Effect.catchDefect(() =>
      Effect.succeed(
        buildHarnessGraph({
          fns: [],
          services: [],
          layers: [],
          errors: [],
          tests: [],
          patternDocs: [],
        }),
      ),
    ),
  )
}

export const isPathInsideRoot = (rootDir: string, candidatePath: string): boolean => {
  const rel = path.relative(path.resolve(rootDir), path.resolve(candidatePath))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export const runDefaultLspDiagnostics = (
  repoRoot: string,
  input: {
    readonly file?: string | undefined
    readonly project?: string | undefined
  },
): Effect.Effect<LspDiagnosticsReport> =>
  Effect.try(() => {
    const cliArgs = ["diagnostics", "--strict", "--format", "json"]
    if (input.file !== undefined && input.file.trim().length > 0) {
      const resolvedFile = path.isAbsolute(input.file)
        ? input.file
        : path.resolve(repoRoot, input.file)
      if (input.project !== undefined && input.project.trim().length > 0) {
        const resolvedProject = path.isAbsolute(input.project)
          ? input.project
          : path.resolve(repoRoot, input.project)
        cliArgs.push("--project", resolvedProject)
      } else {
        const normalizedRepoRoot = path.resolve(repoRoot)
        let curr = path.dirname(resolvedFile)
        while (isPathInsideRoot(normalizedRepoRoot, curr) && curr !== normalizedRepoRoot) {
          const candidate = path.join(curr, "tsconfig.json")
          if (fs.existsSync(candidate)) {
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
      const rawProject = input.project ?? "tsconfig.base.json"
      const resolvedProject = path.isAbsolute(rawProject)
        ? rawProject
        : path.resolve(repoRoot, rawProject)
      cliArgs.push("--project", resolvedProject)
    }

    const binPath = path.join(findRepoRoot(repoRoot), "node_modules", ".bin", "effect-tsgo")
    const proc = spawnSync(binPath, cliArgs, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30_000,
    })
    const stdout = (proc.stdout ?? "").trim()
    const decoded = decodeLspDiagnosticsPayload(stdout)
    if (Option.isSome(decoded)) {
      const { diagnostics, summary } = decoded.value
      return {
        clean: summary.errors === 0 && summary.warnings === 0 && summary.filesWithoutPlugin === 0,
        diagnostics,
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
    } else if (stdout.length > 0) {
      failureDetails.push(stdout)
    }
    if (failureDetails.length === 0) {
      failureDetails.push("[lsp-error] effect-tsgo produced no valid JSON diagnostic payload")
    }

    return {
      clean: false,
      diagnostics: failureDetails,
      summary: {
        filesChecked: 0,
        filesWithoutPlugin: 0,
        totalFiles: 0,
        errors: 1,
        warnings: 0,
        messages: failureDetails.length,
      },
    } satisfies LspDiagnosticsReport
  }).pipe(
    Effect.catch((cause): Effect.Effect<LspDiagnosticsReport> => {
      const msg = `[lsp-exception] ${cause instanceof Error ? cause.message : String(cause)}`
      return Effect.succeed({
        clean: false,
        diagnostics: [msg],
        summary: {
          filesChecked: 0,
          filesWithoutPlugin: 0,
          totalFiles: 0,
          errors: 1,
          warnings: 0,
          messages: 1,
        },
      })
    }),
  )

export const executeToolEffect = Effect.fn("HarnessMcp.executeTool")(function* (
  toolName: string,
  args: Record<string, unknown>,
  options?: ServerOptions,
) {
  const startTime = performance.now()
  let result: unknown

  switch (toolName) {
    case "harness_resolve": {
      const symbolOrSpan = (args as { symbolOrSpan: string }).symbolOrSpan
      const graph = yield* resolveGraph(options, args)
      result = resolveNode(graph, symbolOrSpan) ?? null
      break
    }
    case "harness_callers": {
      const symbolOrSpan = (args as { symbolOrSpan: string }).symbolOrSpan
      const graph = yield* resolveGraph(options, args)
      result = findCallers(graph, symbolOrSpan)
      break
    }
    case "harness_callees": {
      const symbolOrSpan = (args as { symbolOrSpan: string }).symbolOrSpan
      const graph = yield* resolveGraph(options, args)
      result = findCallees(graph, symbolOrSpan)
      break
    }
    case "harness_tests_reaching": {
      const symbolOrSpan = (args as { symbolOrSpan: string }).symbolOrSpan
      const graph = yield* resolveGraph(options, args)
      result = findTestsReaching(graph, symbolOrSpan)
      break
    }
    case "harness_structural_search": {
      const pattern = (args as { pattern: string }).pattern
      const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
      result = structuralSearch({ pattern, repoRoot: root })
      break
    }
    case "harness_route": {
      const planStep = (args as { planStep: string }).planStep
      const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
      const routedOpt = yield* routeStep(planStep).pipe(
        Effect.provide(decisionLayer),
        Effect.timeoutOption("1500 millis"),
        Effect.catchCause(() => Effect.succeedNone),
      )
      let block: string = Option.getOrElse(routedOpt, () => "review")
      const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
      if (block === "review") {
        const patternsDir = path.join(root, "agent-patterns")
        if (fs.existsSync(patternsDir)) {
          const files = fs.readdirSync(patternsDir)
          const stepLower = planStep.toLowerCase()
          const candidates = files
            .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
            .map((f) => f.replace(/\.md$/, ""))
            .sort((a, b) => b.length - a.length)
          for (const slug of candidates) {
            const words = slug.split("-").filter((w) => w.length > 0)
            if (words.length > 0 && words.every((w) => stepLower.includes(w))) {
              block = slug
              break
            }
          }
        }
      }
      const patternFile =
        block === "review" || block === "effect" ? null : `agent-patterns/${block}.md`
      result = { block, patternFile }
      break
    }
    case "harness_ontology_why": {
      const symbolOrSpan = (args as { symbolOrSpan: string }).symbolOrSpan
      const graph = yield* resolveGraph(options, args)
      result = queryOntologyWhy(graph, symbolOrSpan)
      break
    }
    case "harness_ontology_impact": {
      const symbolOrSpan = (args as { symbolOrSpan: string }).symbolOrSpan
      const graph = yield* resolveGraph(options, args)
      result = queryOntologyImpact(graph, symbolOrSpan)
      break
    }
    case "harness_ontology_check": {
      const scope = (args as { scope?: string | undefined }).scope
      const graph = yield* resolveGraph(options, args)
      const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
      const docs = options?.governanceDocs ?? loadGovernanceDocsFromDisk(root)
      const invariants = yield* decideOntologyInvariants({
        graph,
        governanceDocs: docs,
      })
      const pairs = extractOntologyConflictPairs(docs, scope)
      const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
      const semanticConflicts = yield* evaluateOntologyConflicts(pairs).pipe(
        Effect.provide(decisionLayer),
      )
      const projection = projectOntologyLayers(graph)
      result = {
        clean: invariants.clean && semanticConflicts.length === 0,
        findings: invariants.findings,
        semanticConflicts,
        evaluatedPairs: pairs.length,
        layerCounts: {
          Motivation: projection.layers.Motivation.length,
          Business: projection.layers.Business.length,
          Application: projection.layers.Application.length,
          Technology: projection.layers.Technology.length,
          Implementation: projection.layers.Implementation.length,
        },
      }
      break
    }
    case "harness_gq_query": {
      const queryName = (args as { queryName: HarnessGqQueryName }).queryName
      const params = (args as { params?: Record<string, unknown> | undefined }).params
      const branch = (args as { branch?: string | undefined }).branch
      const graph = yield* resolveGraph(options, args)
      const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
      result = yield* invokeOmnigraphNamedQuery({
        repoRoot: root,
        name: queryName as HarnessGqQueryName,
        params,
        branch,
        fallbackGraph: graph,
      }).pipe(Effect.provide(OmnigraphSync.Live))
      break
    }
    case "harness_lsp_diagnostics": {
      const file = (args as { file?: string | undefined }).file
      const project = (args as { project?: string | undefined }).project
      const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
      if (options?.lspDiagnosticsRunner !== undefined) {
        result = options.lspDiagnosticsRunner({ file, project })
      } else {
        result = yield* runDefaultLspDiagnostics(root, { file, project })
      }
      break
    }
    case "harness_telemetry_report": {
      const format = (args as { format?: "json" | "markdown" | undefined }).format
      const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
      const events = readTelemetryEvents(root)
      const frictionEvents = readFrictionEvents(root)
      const report = buildSessionReport({ events, frictionEvents })
      if (format === "markdown") {
        return { markdown: renderSessionReportMarkdown(report), report }
      }
      return report
    }
    case "harness_graph_infer": {
      const symbolOrSpan = (args as { symbolOrSpan?: string | undefined }).symbolOrSpan
      const ruleId = (args as { ruleId?: string | undefined }).ruleId
      const graph = yield* resolveGraph(options, args)
      const resolvedNode =
        symbolOrSpan !== undefined && symbolOrSpan.length > 0
          ? resolveNode(graph, symbolOrSpan)
          : undefined
      const resolvedKey = resolvedNode !== undefined ? getNodeKey(resolvedNode) : undefined
      const inference = yield* decideGraphInference(graph)
      const filterBySymbol = (text: string): boolean =>
        symbolOrSpan === undefined ||
        symbolOrSpan.length === 0 ||
        text.includes(symbolOrSpan) ||
        (resolvedKey !== undefined && text.includes(resolvedKey))
      result = {
        effectiveRequires: inference.effectiveRequires.filter(
          (f) => filterBySymbol(f.callerKey) || filterBySymbol(f.serviceKey),
        ),
        effectiveFailsWith: inference.effectiveFailsWith.filter(
          (f) => filterBySymbol(f.callerKey) || filterBySymbol(f.errorKey),
        ),
        effectiveLayerDeps: inference.effectiveLayerDeps.filter(
          (f) => filterBySymbol(f.layerKey) || filterBySymbol(f.requiredServiceKey),
        ),
        effectiveTestReach: inference.effectiveTestReach.filter(
          (f) => filterBySymbol(f.testKey) || filterBySymbol(f.targetSpanKey),
        ),
        antiPatterns: inference.antiPatterns.filter(
          (ap) =>
            (ruleId === undefined || ap.ruleId === ruleId || ap.datalogRuleId === ruleId) &&
            (filterBySymbol(ap.nodeKey) || ap.path.some((p) => filterBySymbol(p))),
        ),
        typedHoleBundles: (inference.typedHoleBundles ?? []).filter(
          (b) => filterBySymbol(b.holeQualname) || filterBySymbol(b.spanName),
        ),
        proofs: inference.proofs.filter(
          (p) =>
            (ruleId === undefined || p.ruleId === ruleId) &&
            filterBySymbol(p.conclusion),
        ),
        iterations: inference.iterations ?? 0,
      }
      break
    }
    case "harness_graph_complete": {
      const symbolOrSpan = (args as { symbolOrSpan?: string | undefined }).symbolOrSpan
      const minConfidenceMillis =
        (args as { minConfidenceMillis?: number | undefined }).minConfidenceMillis ?? 0
      const ruleId = (args as { ruleId?: string | undefined }).ruleId
      const useDecisionPriors =
        (args as { useDecisionPriors?: boolean | undefined }).useDecisionPriors === true
      const rawPriors = (args as {
        priors?:
          | SemanticEdgePriors
          | {
              readonly edgeConfidenceByRelationTargetRole?: Record<string, number>
              readonly teleportationWeightByNodeKey?: Record<string, number>
            }
          | undefined
      }).priors
      const graph = yield* resolveGraph(options, args)
      const resolvedNode =
        symbolOrSpan !== undefined && symbolOrSpan.length > 0
          ? resolveNode(graph, symbolOrSpan)
          : undefined
      const resolvedKey = resolvedNode !== undefined ? getNodeKey(resolvedNode) : undefined
      const filterBySymbol = (text: string): boolean =>
        symbolOrSpan === undefined ||
        symbolOrSpan.length === 0 ||
        text.includes(symbolOrSpan) ||
        (resolvedKey !== undefined && text.includes(resolvedKey))

      let priors: SemanticEdgePriors | undefined = undefined
      if (useDecisionPriors) {
        const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
        const edgeConfidenceOverrides: Record<string, ConfidenceMillis> = {}
        const holeTeleportationWeights: Record<NodeKey, PageRankScoreMillis> = {}

        const stubFns: Array<EffectFnNode> = []
        const candidateEntities: Array<EntityNode> = []

        for (const [, node] of Graph.nodes(graph.graph)) {
          if (isEntityNode(node)) {
            if (node._tag === "EffectFn" && node.isStub === true) {
              stubFns.push(node)
            } else if (
              node._tag === "EffectFn" ||
              node._tag === "ServiceTag" ||
              node._tag === "TaggedError" ||
              node._tag === "SchemaDef"
            ) {
              candidateEntities.push(node)
            }
          }
        }

        if (stubFns.length === 0) {
          const candidateNode = symbolOrSpan ? resolveNode(graph, symbolOrSpan) : undefined
          if (candidateNode && candidateNode._tag === "EffectFn") {
            stubFns.push(candidateNode)
          } else {
            for (const [, node] of Graph.nodes(graph.graph)) {
              if (node._tag === "EffectFn") {
                stubFns.push(node)
                break
              }
            }
          }
        }

        for (const stub of stubFns) {
          const holeSpanName = stub.spanName.length > 0 ? stub.spanName : stub.qualname
          for (const cand of candidateEntities) {
            const candKey = getNodeKey(cand)
            const proposedRole = match(cand._tag)
              .with("ServiceTag", () => "requires-service")
              .with("TaggedError", () => "fails-with")
              .with("EffectFn", () => "callee")
              .with("SchemaDef", () => "uses-schema")
              .otherwise(() => "collaborator")

            const candidateSummary = match(cand)
              .with({ _tag: "EffectFn" }, (n) => `Effect.fn('${n.spanName}')`)
              .with({ _tag: "ServiceTag" }, (n) => `Context.Service<${n.name}>`)
              .with({ _tag: "TaggedError" }, (n) => `TaggedError('${n.errorTag}')`)
              .with({ _tag: "SchemaDef" }, (n) => `Schema '${n.schemaName}'`)
              .with(
                { _tag: "ServiceLayer" },
                { _tag: "VitestCase" },
                { _tag: "PatternDoc" },
                { _tag: "AdrDoc" },
                { _tag: "EarsSpec" },
                () => candKey,
              )
              .exhaustive()

            const priorResult = yield* evaluateHoleCandidatePrior({
              holeSpanName,
              holeSignatureSummary: stub.successType ?? "Effect<unknown, unknown, unknown>",
              candidateSymbolKey: CandidateSymbolKey.make(candKey),
              candidateSignatureSummary: candidateSummary,
              proposedRole: ProposedRoleName.make(proposedRole),
              earsClauseContext: `While executing ${stub.spanName}, hole delegates to ${candKey}`,
            }).pipe(
              Effect.provide(decisionLayer),
              Effect.timeoutOption("1500 millis"),
              Effect.catchCause(() => Effect.succeedNone),
            )

            if (Option.isSome(priorResult)) {
              edgeConfidenceOverrides[candKey] = priorResult.value.edgeConfidenceMillis
              holeTeleportationWeights[NodeKey.make(candKey)] = PageRankScoreMillis.make(
                priorResult.value.teleportationWeightMillis,
              )
            }
          }
        }

        priors = {
          edgeConfidenceOverrides,
          holeTeleportationWeights,
        }
      } else if (rawPriors !== undefined) {
        const edgeOverrides: Record<string, ConfidenceMillis> = {}
        const teleportWeights: Record<NodeKey, PageRankScoreMillis> = {}
        const sourceEdges =
          "edgeConfidenceOverrides" in rawPriors && rawPriors.edgeConfidenceOverrides
            ? rawPriors.edgeConfidenceOverrides
            : "edgeConfidenceByRelationTargetRole" in rawPriors &&
                rawPriors.edgeConfidenceByRelationTargetRole
              ? rawPriors.edgeConfidenceByRelationTargetRole
              : {}
        for (const [k, v] of Object.entries(sourceEdges)) {
          edgeOverrides[k] = ConfidenceMillis.make(v)
        }
        const sourceTeleport =
          "holeTeleportationWeights" in rawPriors && rawPriors.holeTeleportationWeights
            ? rawPriors.holeTeleportationWeights
            : "teleportationWeightByNodeKey" in rawPriors &&
                rawPriors.teleportationWeightByNodeKey
              ? rawPriors.teleportationWeightByNodeKey
              : {}
        for (const [k, v] of Object.entries(sourceTeleport)) {
          teleportWeights[NodeKey.make(k)] = PageRankScoreMillis.make(v)
        }
        priors = {
          edgeConfidenceOverrides: edgeOverrides,
          holeTeleportationWeights: teleportWeights,
        }
      }

      const inference = yield* decideGraphInference(graph, priors)
      const suggestedEdges = inference.suggestedEdges.filter(
        (se) =>
          se.confidenceMillis >= minConfidenceMillis &&
          (ruleId === undefined || se.ruleId === ruleId || se.relationTag === ruleId) &&
          (symbolOrSpan === undefined ||
            symbolOrSpan.length === 0 ||
            (se.sourceEntityKey !== undefined && filterBySymbol(se.sourceEntityKey)) ||
            filterBySymbol(se.targetEntityKey) ||
            filterBySymbol(se.rationale)),
      )
      const typedHoleBundles = (inference.typedHoleBundles ?? []).filter(
        (b) => filterBySymbol(b.holeQualname) || filterBySymbol(b.spanName),
      )
      const proofIds = new Set(suggestedEdges.map((se) => se.proof.proofId))
      for (const b of typedHoleBundles) {
        proofIds.add(`proof:COMP-06:EffectFn:${b.holeQualname}` as typeof suggestedEdges[number]["proof"]["proofId"])
      }
      result = {
        suggestedEdges,
        typedHoleBundles,
        proofs: inference.proofs.filter((p) => proofIds.has(p.proofId)),
        iterations: inference.iterations ?? 0,
      }
      break
    }
    default: {
      return yield* new UnknownToolError({ toolName })
    }
  }

  const durationMs = Math.max(0, Math.round(performance.now() - startTime))
  if (options?.repoRoot !== undefined || process.env.VITEST === undefined) {
    const root = options?.repoRoot ?? resolveDefaultRepoRoot(args)
    let category: TelemetryCategory = "graph_query"
    if (
      toolName === "harness_ontology_why" ||
      toolName === "harness_ontology_impact" ||
      toolName === "harness_ontology_check"
    ) {
      category = "ontology"
    } else if (toolName === "harness_route") {
      category = "routing"
    } else if (toolName === "harness_lsp_diagnostics") {
      category = "gate"
    } else {
      category = "graph_query"
    }

    let engineSource: TelemetryEngineSource = "local"
    if (toolName === "harness_gq_query") {
      engineSource =
        typeof result === "object" &&
        result !== null &&
        "source" in result &&
        result.source === "omnigraph"
          ? "omnigraph"
          : "memory-fallback"
    } else if (toolName === "harness_route" || toolName === "harness_ontology_check") {
      engineSource = "decision-model"
    } else {
      engineSource = "local"
    }

    let outcome: TelemetryOutcome = "ok"
    if (toolName === "harness_gq_query" && engineSource === "memory-fallback") {
      outcome = "fallback"
    } else if (
      toolName === "harness_lsp_diagnostics" &&
      typeof result === "object" &&
      result !== null &&
      "clean" in result &&
      result.clean === false
    ) {
      outcome = "fail"
    } else {
      outcome = "ok"
    }

    appendTelemetryEvent(root, {
      surface: "mcp",
      category,
      toolName,
      outcome,
      durationMs,
      engineSource,
    })
  }

  return result
})

export const executeTool = (
  toolName: string,
  args: Record<string, unknown>,
  options?: ServerOptions,
): Promise<unknown> => Effect.runPromise(executeToolEffect(toolName, args, options))

export const createServer = (options?: ServerOptions): McpServer => {
  const server = new McpServer({ name: "harness-mcp", version: "0.0.0" })

  server.tool(
    "harness_resolve",
    "Resolve a symbol or span name to its node in the Effect graph",
    { symbolOrSpan: z.string().describe("Symbol or span name to resolve") },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_resolve", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_callers",
    "Find callers of an Effect function, service, or layer",
    { symbolOrSpan: z.string().describe("Symbol or span name to query callers for") },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_callers", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_callees",
    "Find callees of an Effect function, service, or layer",
    { symbolOrSpan: z.string().describe("Symbol or span name to query callees for") },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_callees", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_tests_reaching",
    "Find all Vitest test cases reaching a given symbol or span",
    { symbolOrSpan: z.string().describe("Symbol or span name to find reaching tests for") },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_tests_reaching", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_structural_search",
    "Perform structural AST search using ast-grep across workspace TypeScript code",
    {
      pattern: z
        .string()
        .describe("ast-grep pattern to search for across workspace TypeScript files"),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_structural_search", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_route",
    "Route an implementation plan step to an Effect idiom building block using local decision model",
    {
      planStep: z
        .string()
        .describe("Implementation plan step text to route to an Effect idiom block"),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_route", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_ontology_why",
    "Trace upward from any symbol, service, layer, error, or span to Motivation (EARS & ADR)",
    {
      symbolOrSpan: z
        .string()
        .describe(
          "Symbol, service, layer, error, or span name to trace upward to Motivation (EARS & ADR)",
        ),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_ontology_why", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_ontology_impact",
    "Analyze cross-layer ArchiMate impact for a symbol, service, layer, error, or span",
    {
      symbolOrSpan: z
        .string()
        .describe(
          "Symbol, service, layer, error, or span name to analyze cross-layer ArchiMate impact for",
        ),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_ontology_impact", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_ontology_check",
    "Check deterministic cross-layer ArchiMate invariants and Clef semantic conflicts across governance docs and graph",
    {
      scope: z
        .string()
        .optional()
        .describe(
          "Optional scope name (e.g. 'sample') to check deterministic cross-layer invariants and Clef semantic conflicts",
        ),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_ontology_check", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_gq_query",
    "Execute a canonical Omnigraph .gq query (against live Omnigraph v0.14.0 or deterministic in-memory fallback)",
    {
      queryName: z
        .enum(HARNESS_GQ_QUERY_NAMES)
        .describe("Name of the canonical .gq query in libs/harness/graph/queries/harness.gq"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Query parameters matching $var placeholders"),
      branch: z.string().optional().describe("Target graph branch (defaults to 'main')"),
      repoRoot: z.string().optional().describe("Target repository root for cluster resolution"),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_gq_query", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_graph_infer",
    "Run the Stratified Datalog inference engine (GraphInfer.decide over @electric-sql/d2ts) on the PERA hypergraph to compute transitive closures, antipatterns (INF-04..09), and derivation proofs",
    {
      symbolOrSpan: z
        .string()
        .optional()
        .describe("Optional symbol or span filter for derived facts and antipatterns"),
      ruleId: z
        .string()
        .optional()
        .describe("Optional Datalog rule ID filter (e.g. 'INF-04', 'INF-05')"),
      repoRoot: z.string().optional().describe("Optional repository root path"),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_graph_infer", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_graph_complete",
    "Run normative missing-edge completion (COMP-01..05 in Stratum S3 of GraphInfer.decide) to propose SuggestedEdges with ConfidenceMillis and DerivationProof DAGs",
    {
      symbolOrSpan: z
        .string()
        .optional()
        .describe("Optional symbol or span filter for suggested hyperedges"),
      minConfidenceMillis: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe("Minimum confidence in millis (0..1000, default 0)"),
      ruleId: z
        .string()
        .optional()
        .describe("Optional completion rule ID filter (e.g. 'COMP-01'..'COMP-05')"),
      repoRoot: z.string().optional().describe("Optional repository root path"),
      useDecisionPriors: z
        .boolean()
        .optional()
        .describe(
          "Optional flag to evaluate System One edge and teleportation priors for typed holes",
        ),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_graph_complete", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_lsp_diagnostics",
    "Run Effect Language Service (@effect/tsgo) strict JSON diagnostics on a specific file or tsconfig project",
    {
      file: z
        .string()
        .optional()
        .describe("Optional file path to check for Effect Language Service diagnostics"),
      project: z
        .string()
        .optional()
        .describe("Optional tsconfig.json path to check (defaults to tsconfig.base.json)"),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_lsp_diagnostics", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  server.tool(
    "harness_telemetry_report",
    "Generate a session observability and tool-usage health report across CLI, hooks, and MCP tools",
    {
      format: z
        .enum(["json", "markdown"])
        .optional()
        .describe("Report output format (defaults to 'json')"),
    },
    (args) =>
      Effect.runPromise(
        executeToolEffect("harness_telemetry_report", args, options).pipe(
          Effect.map((data) => ({
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          })),
        ),
      ),
  )

  return server
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = createServer()
  const transport = new StdioServerTransport()
  void Effect.runPromise(Effect.tryPromise(() => server.connect(transport)))
}
