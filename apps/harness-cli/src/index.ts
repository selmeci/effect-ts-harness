import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match, P } from "ts-pattern"
import {
  checkPlanStepCoverage,
  decideGuardCommand,
  deterministicLearnFallback,
  evaluateOntologyConflicts,
  extractOntologyConflictPairs,
  IDIOM_BLOCKS,
  IdiomRouterV1,
  LocalDecisionModel,
  proposeLearningAction,
  routeStep,
  triageFailure,
} from "@harness/decision"
import {
  appendFrictionEvent,
  appendTelemetryEvent,
  AstGateCache,
  AstSourceContent,
  AstSourceFilePath,
  BenchStageName,
  buildSessionHandoff,
  buildSessionReport,
  buildStageLatencyMeasurement,
  CD_COMMAND_BANNED_REASON,
  checkLoopThrashing,
  checkVerifyStamp,
  classifyCommand,
  classifyFileWrite,
  clearFrictionEvents,
  clearTelemetryEvents,
  collectModularPluginFiles,
  decideHarnessBench,
  decideOmnigraphReconcile,
  decideOntologyInvariants,
  DEFAULT_STAGE_LATENCY_BUDGETS,
  deriveRepoOmnigraphPort,
  diffPlanAndImplGraphs,
  DstErrorTag,
  DstExecutionTier,
  decideEarsSpecQuality,
  decidePlanSearch,
  decideRuleSynthesizer,
  decideSpanBudgets,
  DstMethodName,
  DstServiceTag,
  DstStepCount,
  type DstTargetServiceMethod as DstTargetMethodSpec,
  EarsClauseId,
  EarsClausePatternKind,
  EarsClausePolarity,
  EarsConsistencyFlag,
  type EarsConsistencyInput,
  EarsEffectSymbolName,
  EarsFilePath,
  EarsGuardText,
  EarsOutcomeTag,
  type EarsSemanticClause,
  EarsSpecId,
  EarsVariantTag,
  evaluateEarsConsistencyReport,
  type FrictionEventKind,
  type GovernanceDocReference,
  HARNESS_GATE_RULE_VERSION,
  INTERACTIVE_NX_BANNED_REASON,
  isModularPluginPath,
  normalizeConditionPrefix,
  parseDstSeedEnv,
  PlanSearchInput,
  RuleSynthesizerInput,
  runDstSeedSuite,
  type SpanSample,
  isCdCommand,
  isInteractiveNxCommand,
  LatencyMillis,
  LatencySloViolationError,
  loadGovernanceDocsFromDisk,
  readFrictionEvents,
  readGraphHeadMeta,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  resolveCanonicalRepoRoot,
  resolveGitHeadState,
  resolveHarnessStateDir,
  resolveOmnigraphClusterDir,
  resolveOmnigraphTaskBranches,
  runDomainMutationSuite,
  scanGraphEntropy,
  scanWorkspacePackageHygiene,
  scopeSessionReportInput,
  summarizeFrictionEvents,
  type TelemetryCategory,
  type TelemetryEngineSource,
  type TelemetryOutcome,
  type TelemetrySurface,
  writeGraphHeadMeta,
  writeSessionReportFiles,
  writeVerifyStamp,
  evaluateAllGatePlugins,
  GatePluginRegistryLive,
  WorkspaceFsLive,
  WorkspaceFilePath,
} from "@harness/gates"
import {
  CANONICAL_CLI_COMMAND_NAMES,
  CliCommandName,
  dispatchCliCommand,
  type HarnessCommandRegistry,
  makeHarnessCommandRegistryLayer,
  registerLiveCliCommandHandlers,
} from "./commands/command-registry.js"
import {
  BisectionProbeCount,
  checkEffectGraph,
  clearWarmProgramSessions,
  DatalogFilePath,
  DatalogSession,
  decideGraphProjection,
  decideGraphRewrite,
  diffOmnigraphBranches,
  extractGraphViaCompilerOverlay,
  extractTypeGraph,
  extractWorkspaceTypeAwareGraph,
  findTestsReaching,
  getNodeKey,
  getOrCreateWarmProgramSession,
  type HarnessGraph,
  loadGraphSnapshotEffect,
  mergeOmnigraphBranch,
  OmnigraphSync,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
  renderOntologyMermaid,
  saveGraphSnapshot,
  type ShadowFileOverlay,
  stepDatalogFileDelta,
  syncToOmnigraphAndSnapshot,
  TsCompilerOverlayServiceLive,
  VerificationStatus,
} from "@harness/graph"
import { buildWorkspaceFnIndex } from "@harness/ingest"

export const COMMANDS = [
  "guard",
  "route",
  "plan-check",
  "plan-synth",
  "repair",
  "verify",
  "done",
  "learn",
  "gc",
  "mutate",
  "bench",
  "ingest",
  "session",
  "doctor",
  "ontology",
  "report",
  "help",
] as const

export type Command = (typeof COMMANDS)[number]

export const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value)

export interface CliEnv {
  readonly repoRoot?: string | undefined
  readonly stdin?: string | undefined
  readonly decisionLayer?: Layer.Layer<DecisionModel.DecisionModel> | undefined
  readonly planGraph?: HarnessGraph | undefined
  readonly implGraph?: HarnessGraph | undefined
  readonly planSteps?:
    | ReadonlyArray<{
        readonly stepId: string
        readonly planStep: string
        readonly stepDiff: string
      }>
    | undefined
  readonly skipSubprocessVerify?: boolean | undefined
  readonly governanceDocs?: ReadonlyArray<GovernanceDocReference> | undefined
}

export interface CliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly telemetryDetail?: string | undefined
}

const PreToolUseStdinSchema = Schema.Struct({
  tool_name: Schema.optional(Schema.String),
  tool_input: Schema.optional(
    Schema.Struct({
      command: Schema.optional(Schema.String),
      file_path: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
    }),
  ),
  toolCall: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      args: Schema.optional(
        Schema.Struct({
          CommandLine: Schema.optional(Schema.String),
          command: Schema.optional(Schema.String),
          TargetFile: Schema.optional(Schema.String),
          AbsolutePath: Schema.optional(Schema.String),
          file_path: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
})

const decodePreToolUseStdin = Schema.decodeOption(Schema.fromJsonString(PreToolUseStdinSchema))

const CLI_REPO_ROOT = (() => {
  let curr = resolve(dirname(fileURLToPath(import.meta.url)))
  while (curr !== dirname(curr)) {
    if (existsSync(join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = dirname(curr)
  }
  return process.cwd()
})()

const findWorkspaceRoot = (startDir: string = process.cwd()): string => {
  let curr = resolve(startDir)
  while (curr !== dirname(curr)) {
    if (existsSync(join(curr, "pnpm-workspace.yaml"))) {
      return curr
    }
    curr = dirname(curr)
  }
  return CLI_REPO_ROOT
}

const isIsolatedExternalWorkspace = (repoRoot: string): boolean => {
  if (existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))) {
    return false
  }
  const explicitEnvUrl =
    process.env.OMNIGRAPH_URL && process.env.OMNIGRAPH_URL !== "http://127.0.0.1:8080"
  if (explicitEnvUrl) {
    return false
  }
  return resolveCanonicalRepoRoot(repoRoot) !== resolveCanonicalRepoRoot(CLI_REPO_ROOT)
}

const ANSI_REGEX = new RegExp(
  `[${String.fromCharCode(27)}${String.fromCharCode(155)}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
)

export const stripAnsiCodes = (text: string): string => text.replace(ANSI_REGEX, "")

export const cleanSubprocessError = (raw: string): string => {
  const noAnsi = stripAnsiCodes(raw)
  const lines = noAnsi.split(/\r?\n/)
  const filtered: Array<string> = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.includes("[existing outputs match the cache, left as is]")) {
      continue
    }
    if (/^✔\s+nx run\b/.test(trimmed)) {
      continue
    }
    if (trimmed.startsWith("Output of") && trimmed.includes("successful tasks were not shown")) {
      continue
    }
    if (
      trimmed.startsWith("Run duration:") ||
      trimmed.startsWith("Cache:") ||
      trimmed.startsWith("Critical path:") ||
      trimmed.startsWith("Recoverable time:")
    ) {
      continue
    }
    filtered.push(line)
  }

  const result = filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return result.length > 0 ? result : noAnsi.trim()
}

export const formatSubprocessError = (err: unknown): string => {
  let raw = ""
  if (typeof err === "object" && err !== null) {
    const rec = err as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const stdout =
      typeof rec.stdout === "string"
        ? rec.stdout
        : Buffer.isBuffer(rec.stdout)
          ? rec.stdout.toString("utf8")
          : ""
    const stderr =
      typeof rec.stderr === "string"
        ? rec.stderr
        : Buffer.isBuffer(rec.stderr)
          ? rec.stderr.toString("utf8")
          : ""
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
    if (combined.length > 0) {
      raw = combined
    } else if (typeof rec.message === "string") {
      raw = rec.message
    }
  } else {
    raw = String(err)
  }
  return cleanSubprocessError(raw)
}

const handleGuard = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const isAntigravityFlag = argv.includes("--format=antigravity")
    const fileFlag = argv.find((arg) => arg.startsWith("--file="))
    const cliFilePath = fileFlag ? fileFlag.slice("--file=".length) : undefined
    const positionalArgs = argv
      .slice(1)
      .filter((arg) => arg !== "--format=antigravity" && !arg.startsWith("--file="))

    let rawStdin = options?.stdin
    if (
      positionalArgs.length === 0 &&
      !cliFilePath &&
      rawStdin === undefined &&
      !process.stdin.isTTY
    ) {
      rawStdin = yield* Effect.try({
        try: () => readFileSync(0, "utf8"),
        catch: () => "",
      }).pipe(Effect.orElseSucceed(() => ""))
    }

    let stdinCmd: string | undefined
    let stdinFilePath: string | undefined
    let isAntigravityStdin = false
    if (rawStdin) {
      const decoded = decodePreToolUseStdin(rawStdin)
      if (Option.isSome(decoded)) {
        if (decoded.value.toolCall !== undefined) {
          isAntigravityStdin = true
          stdinCmd =
            decoded.value.toolCall.args?.CommandLine ?? decoded.value.toolCall.args?.command
          stdinFilePath =
            decoded.value.toolCall.args?.TargetFile ??
            decoded.value.toolCall.args?.AbsolutePath ??
            decoded.value.toolCall.args?.file_path
        } else {
          stdinCmd = decoded.value.tool_input?.command
          stdinFilePath = decoded.value.tool_input?.file_path ?? decoded.value.tool_input?.path
        }
      }
    }
    const isAntigravity = isAntigravityFlag || isAntigravityStdin
    const filePath = cliFilePath ?? stdinFilePath
    const command = positionalArgs.length > 0 ? positionalArgs.join(" ") : (stdinCmd ?? "")

    if (filePath && command.trim() === "") {
      const fileGuard = classifyFileWrite(filePath)
      if (fileGuard.verdict === "deny") {
        if (isAntigravity) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: "deny",
              reason: fileGuard.reason,
            }),
            stderr: "",
          }
        }
        return {
          exitCode: 2,
          stdout: "",
          stderr: fileGuard.reason ?? `Blocked file write: ${filePath}`,
        }
      }
      if (fileGuard.verdict === "ask") {
        if (isAntigravity) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: "ask",
              reason: fileGuard.reason,
            }),
            stderr: "",
          }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
              permissionDecisionReason: fileGuard.reason,
            },
          }),
          stderr: "",
        }
      }
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: "",
      }
    }

    if (command.trim() === "") {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: "",
      }
    }

    const classification = classifyCommand(command)
    if (classification === "deny") {
      const isInteractiveNx = isInteractiveNxCommand(command)
      const denyReason = isCdCommand(command)
        ? `Blocked by harness guard: ${command} (${CD_COMMAND_BANNED_REASON})`
        : isInteractiveNx
          ? `Blocked by harness guard: ${command} (${INTERACTIVE_NX_BANNED_REASON})`
          : `Blocked by harness guard: ${command}`
      if (isAntigravity) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "deny",
            reason: denyReason,
          }),
          stderr: "",
        }
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: denyReason,
      }
    }
    if (classification === "allow") {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: "",
      }
    }
    if (classification === "ask") {
      if (isAntigravity) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "ask",
            reason: `Command requires human confirmation: ${command}`,
          }),
          stderr: "",
        }
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `Command requires human confirmation: ${command}`,
          },
        }),
        stderr: "",
      }
    }

    // Classification is "escalate" -> consult decision layer
    if (options?.decisionLayer === undefined && process.env.VITEST === undefined) {
      yield* ensureLocalOllamaReady()
    }
    const decision = yield* decideGuardCommand(command).pipe(Effect.provide(decisionLayer))
    recordFriction(options, {
      kind: "guard_escalation",
      summary: command,
      detail: `verdict=${decision.verdict}; reason=${decision.reason}`,
    })

    if (decision.verdict === "deny") {
      const isInteractiveNx = isInteractiveNxCommand(command)
      const denyReason = isInteractiveNx
        ? `Blocked by harness guard: ${command} (${INTERACTIVE_NX_BANNED_REASON})`
        : `Blocked by harness guard: ${command}`
      if (isAntigravity) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "deny",
            reason: denyReason,
          }),
          stderr: "",
        }
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: denyReason,
      }
    }
    if (decision.verdict === "allow") {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: "",
      }
    }
    if (isAntigravity) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: "ask",
          reason: decision.reason,
        }),
        stderr: "",
      }
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: decision.reason,
        },
      }),
      stderr: "",
    }
  })

const recordFriction = (
  options: CliEnv | undefined,
  event: {
    readonly kind: FrictionEventKind
    readonly summary: string
    readonly detail: string
  },
): void => {
  if (options?.repoRoot === undefined && process.env.VITEST !== undefined) {
    return
  }
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  appendFrictionEvent(repoRoot, event)
}

const recordTelemetry = (
  options: CliEnv | undefined,
  event: {
    readonly surface: TelemetrySurface
    readonly category: TelemetryCategory
    readonly toolName: string
    readonly outcome: TelemetryOutcome
    readonly durationMs: number
    readonly engineSource?: TelemetryEngineSource | undefined
    readonly detail?: string | undefined
  },
): void => {
  if (options?.repoRoot === undefined && process.env.VITEST !== undefined) {
    return
  }
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  appendTelemetryEvent(repoRoot, event)
}

const handleRoute = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const step = argv.slice(1).join(" ")
    const block = yield* routeStep(step).pipe(Effect.provide(decisionLayer))
    if (block === "review") {
      recordFriction(options, {
        kind: "route_miss",
        summary: step,
        detail:
          "IdiomRouterV1 returned review (no matching agent-patterns/*.md with >= 0.7 confidence)",
      })
    }
    const stdout = block === "review" || block === "effect" ? block : `agent-patterns/${block}.md`
    return { exitCode: 0, stdout, stderr: "" }
  })

const resolveNxAffectedArgs = (
  repoRoot: string,
  targets: ReadonlyArray<string>,
  explicitFiles?: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (explicitFiles !== undefined && explicitFiles.length > 0) {
    return ["nx", "affected", `--files=${explicitFiles.join(",")}`, "-t", ...targets]
  }
  const hasMain = Effect.runSync(
    Effect.try({
      try: () => {
        execFileSync("git", ["rev-parse", "--verify", "main"], {
          cwd: repoRoot,
          stdio: "pipe",
        })
        return true
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false)),
  )
  if (hasMain) {
    return ["nx", "affected", "--base=main", "-t", ...targets]
  }
  const hasHeadParent = Effect.runSync(
    Effect.try({
      try: () => {
        execFileSync("git", ["rev-parse", "--verify", "HEAD~1"], {
          cwd: repoRoot,
          stdio: "pipe",
        })
        return true
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false)),
  )
  if (hasHeadParent) {
    return ["nx", "affected", "--base=HEAD~1", "-t", ...targets]
  }
  return ["nx", "run-many", "-t", ...targets]
}

const handlePlanCheck = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const governanceDocs = options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot)
    const graphOnly = argv.includes("--graph-only")

    const requireOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!graphOnly &&
        !isIsolatedExternalWorkspace(repoRoot) &&
        options?.decisionLayer === undefined &&
        process.env.VITEST === undefined)
    if (requireOllama) {
      const ollamaOk = yield* ensureLocalOllamaReady()
      if (!ollamaOk) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is not running and could not be started automatically. Halting execution.",
        }
      }
    }

    if (
      !graphOnly &&
      !options?.skipSubprocessVerify &&
      existsSync(join(repoRoot, "package.json"))
    ) {
      const nxArgs = resolveNxAffectedArgs(repoRoot, ["typecheck", "lint"])
      const subprocessErr = yield* Effect.try({
        try: () => {
          execFileSync("pnpm", nxArgs, {
            cwd: repoRoot,
            stdio: "pipe",
            env: { ...process.env, HARNESS_PLAN_CHECK: "1", CI: "true" },
          })
          return null
        },
        catch: (cause) => formatSubprocessError(cause),
      }).pipe(Effect.catch((msg) => Effect.succeed(msg || "Plan check subprocess failed")))

      if (subprocessErr !== null) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] plan-check:subprocess\nHINT: Fix compilation or lint errors before plan graph generation.\n\nFAILED OUTPUT:\n${subprocessErr}`,
        }
      }
    }

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
    if (fnIndex.duplicates.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Duplicate span names found: ${fnIndex.duplicates.join(", ")}`,
      }
    }

    const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot)
    const checkResult = checkEffectGraph(graph)

    if (!checkResult.ok) {
      const formattedViolations = checkResult.violations
        .map((v) => `[${v.rule}] ${v.message} (${v.path.join(" -> ")})`)
        .join("\n")
      return {
        exitCode: 1,
        stdout: "",
        stderr: formattedViolations,
      }
    }

    let hasEffectFnNodes = false
    for (const [, node] of Graph.nodes(graph.graph)) {
      if (node._tag === "EffectFn") {
        hasEffectFnNodes = true
        break
      }
    }
    if (hasEffectFnNodes) {
      const failsWithErrorTags = new Set<string>()
      for (const [, node] of Graph.nodes(graph.graph)) {
        if (node._tag === "EffectSignature" || node._tag === "LayerFlow") {
          for (const errTag of node.emittedErrors ?? []) {
            failsWithErrorTags.add(errTag)
          }
        } else if (node._tag === "HttpEndpointTuple") {
          for (const errTag of node.errorTags) {
            failsWithErrorTags.add(errTag)
          }
        }
      }
      for (const [, edge] of Graph.edges(graph.graph)) {
        if (edge.data.role === "fails-with" || edge.data.role === "endpoint-error") {
          const targetOpt = Graph.getNode(graph.graph, edge.target)
          if (Option.isSome(targetOpt) && targetOpt.value._tag === "TaggedError") {
            failsWithErrorTags.add(targetOpt.value.errorTag)
          }
        }
      }
      const violations: Array<string> = []
      for (const doc of governanceDocs) {
        if (doc.status === "accepted" || doc.status === "proposed") {
          for (const errName of doc.referencedErrors ?? []) {
            if (!failsWithErrorTags.has(errName)) {
              violations.push(
                `[dead-tagged-error] Governance doc '${doc.id}' declares TaggedError '${errName}', which has 0 FailsWith edges in the plan graph`,
              )
            }
          }
        }
      }
      if (violations.length > 0) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({ step: "type-graph-policy", valid: false, violations }, null, 2),
          stderr: "",
        }
      }
    }

    if (!graphOnly) {
      const snapshotPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
      if (isIsolatedExternalWorkspace(repoRoot)) {
        saveGraphSnapshot(graph, snapshotPath)
        recordTelemetry(options, {
          surface: "cli",
          category: "graph_query",
          toolName: "omnigraph:sync-plan",
          outcome: "ok",
          durationMs: 1,
          engineSource: "local",
        })
      } else {
        yield* ensureLocalOmnigraphReady(repoRoot)
        const clusterRepoRoot = existsSync(
          join(repoRoot, "libs", "harness", "graph", "cluster.yaml"),
        )
          ? repoRoot
          : findWorkspaceRoot(repoRoot)
        const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
        const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
          repoRoot: clusterRepoRoot,
          branch: taskBranches.planBranch,
          from: taskBranches.mainBranch,
          snapshotPath,
        }).pipe(
          Effect.provide(OmnigraphSync.Live),
          Effect.orElseSucceed(() => ({
            syncedToOmnigraph: false,
            snapshotPath,
            error: undefined,
          })),
        )
        recordTelemetry(options, {
          surface: "cli",
          category: "graph_query",
          toolName: "omnigraph:sync-plan",
          outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
          durationMs: 1,
          engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "memory-fallback",
        })
        if (!syncRes.syncedToOmnigraph) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `Plan check failed: could not sync plan graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`,
          }
        }
      }
    }

    // EARS spec consistency check
    for (const doc of governanceDocs) {
      if (
        doc.markdown !== undefined &&
        (doc.docPath.includes("/specs/") || doc.id.includes(":SPEC-"))
      ) {
        const lintReport = yield* decideEarsSpecQuality({
          docPath: doc.docPath,
          markdown: doc.markdown,
        })
        if (lintReport.requirements.length > 0) {
          const clausesBySymbol = new Map<string, Array<EarsSemanticClause>>()
          for (const req of lintReport.requirements) {
            const sym = req.effectSymbol?.trim()
            if (!sym) continue

            const lowerReq = req.requirement.toLowerCase()
            const isDoubleNegativeAllow = /\bshall\s+not\s+(?:deny|fail|reject)\b/.test(lowerReq)
            const isNot = lowerReq.includes("shall not") && !isDoubleNegativeAllow
            const isFail =
              !isDoubleNegativeAllow &&
              (lowerReq.includes("shall fail") ||
                lowerReq.includes("fails with") ||
                lowerReq.includes("fail with") ||
                lowerReq.includes("shall return deny") ||
                lowerReq.includes("shall return escalate"))

            const failMatch = /fail(?:s)? with\s+`?([A-Za-z0-9_]+)`?/i.exec(req.requirement)
            const errorTag = failMatch?.[1] ?? (isFail ? "Failure" : "Success")

            const patternKind: EarsClausePatternKind = match(req.pattern)
              .with("Ubiquitous", () => EarsClausePatternKind.make("Ubiquitous"))
              .with("Event-driven", () => EarsClausePatternKind.make("Event-driven"))
              .with("State-driven", () => EarsClausePatternKind.make("State-driven"))
              .with("Unwanted behaviour", () => EarsClausePatternKind.make("Unwanted behaviour"))
              .with("Optional feature", () => EarsClausePatternKind.make("Optional feature"))
              .with("Complex", () => EarsClausePatternKind.make("Complex"))
              .otherwise(() => EarsClausePatternKind.make("Complex"))

            const rawPrefix = normalizeConditionPrefix(req.requirement)
            const hasExplicitPrecondition = /^(?:when|while|if|where)\b/i.test(rawPrefix)
            const baseGuardKey = hasExplicitPrecondition
              ? rawPrefix
              : lowerReq.replace(/[*_`]/g, "").trim()
            const effectiveGuardKey = isFail || isNot
              ? baseGuardKey
              : `${baseGuardKey}:${req.id || `REQ-${req.line}`}`

            const clause: EarsSemanticClause = {
              clauseId: EarsClauseId.make(req.id || `REQ-${req.line}`),
              pattern: patternKind,
              effectSymbol: EarsEffectSymbolName.make(sym),
              polarity: isNot
                ? EarsClausePolarity.make("shall_not")
                : EarsClausePolarity.make("shall"),
              outcomeTag: EarsOutcomeTag.make(isFail ? errorTag : "Success"),
              guardVariant: EarsVariantTag.make(
                effectiveGuardKey.length > 0 ? effectiveGuardKey : req.id || `REQ-${req.line}`,
              ),
              guardText: EarsGuardText.make(
                effectiveGuardKey.length > 0 ? effectiveGuardKey : req.requirement.slice(0, 100),
              ),
            }

            const existing = clausesBySymbol.get(sym) ?? []
            existing.push(clause)
            clausesBySymbol.set(sym, existing)
          }

          for (const [, symbolClauses] of clausesBySymbol) {
            if (symbolClauses.length >= 2) {
              const consistencyInput: EarsConsistencyInput = {
                specId: EarsSpecId.make(doc.id),
                filePath: EarsFilePath.make(doc.docPath),
                stateDomainVariants: [],
                guardDomainVariants: [],
                clauses: symbolClauses,
                requireExhaustiveStateCoverage: EarsConsistencyFlag.make(false),
              }
              const report = evaluateEarsConsistencyReport(consistencyInput)
              const blockingViolations = report.violations.filter(
                (v) => v.ruleId === "EARS-01" || v.ruleId === "EARS-02",
              )
              if (blockingViolations.length > 0) {
                return {
                  exitCode: 1,
                  stdout: "",
                  stderr: `[GATE FAILURE] plan-check:ears-consistency\n${blockingViolations.map((v) => `[${v.ruleId}] ${v.message}`).join("\n")}`,
                }
              }
            }
          }
        }
      }
    }

    return { exitCode: 0, stdout: checkResult.mermaid, stderr: "" }
  })

const tryGitDiffRange = (repoRoot: string, range: string): Option.Option<ReadonlyArray<string>> =>
  Effect.runSync(
    Effect.try({
      try: () =>
        Option.some(
          execFileSync("git", ["diff", "--name-only", range], {
            cwd: repoRoot,
            stdio: "pipe",
            encoding: "utf-8",
          })
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        ),
      catch: () => Option.none<ReadonlyArray<string>>(),
    }).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>())),
  )

const readGitBranchDiffFiles = (repoRoot: string): ReadonlyArray<string> => {
  for (const range of ["main...HEAD", "origin/main...HEAD", "HEAD~1...HEAD"]) {
    const opt = tryGitDiffRange(repoRoot, range)
    if (Option.isSome(opt) && opt.value.length > 0) {
      return opt.value
    }
  }
  if (existsSync(join(repoRoot, "libs", "harness", "gates", "src"))) {
    process.stderr.write(
      `[harness:verify] Warning: git branch diff failed or returned empty in ${repoRoot}; falling back to scanning all modular gate files.\n`,
    )
    return collectModularPluginFiles(repoRoot).map((abs) =>
      relative(repoRoot, abs).replace(/\\/g, "/"),
    )
  }
  return []
}

const resolveModifiedFilesSinceStampOrHead = (repoRoot: string): ReadonlyArray<string> =>
  Effect.runSync(
    Effect.try({
      try: () => {
        const files = new Set<string>()
        const raw = execFileSync("git", ["status", "--porcelain", "-uall"], {
          cwd: repoRoot,
          stdio: "pipe",
          encoding: "utf-8",
        })
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed.length < 4) continue
          const relPath = trimmed
            .slice(2)
            .trim()
            .replace(/^.*->\s*/, "")
            .replace(/^"|"$/g, "")
          if (relPath.length > 0) {
            files.add(relPath.replace(/\\/g, "/"))
          }
        }
        for (const diffFile of readGitBranchDiffFiles(repoRoot)) {
          files.add(diffFile.replace(/\\/g, "/"))
        }
        return Array.from(files)
      },
      catch: () => [],
    }).pipe(Effect.orElseSucceed(() => [])),
  )

const isRootConfigOrSharedCoreChange = (modifiedFiles: ReadonlyArray<string>): boolean =>
  modifiedFiles.length === 0 ||
  modifiedFiles.some(
    (f) =>
      !f.includes("/") ||
      f.startsWith("libs/harness/") ||
      f.startsWith("apps/harness-") ||
      f.startsWith("tools/") ||
      f.endsWith("package.json") ||
      f.endsWith("tsconfig.json") ||
      f.endsWith("tsconfig.base.json"),
  )

export const tryQueryWarmDaemonSocket = (
  repoRoot: string,
  command: "ping" | "extract-graph" | "ast-gates" | "plan-check" | "gc" | "verify" | "bench",
  files?: ReadonlyArray<string>,
): Effect.Effect<Option.Option<Record<string, unknown>>> =>
  Effect.gen(function* () {
    const socketPath = join(repoRoot, ".harness", "daemon.sock")
    if (!existsSync(socketPath)) {
      return Option.none()
    }
    return yield* Effect.callback<Option.Option<Record<string, unknown>>>((resume) => {
      const client = net.createConnection({ path: socketPath })
      let buffer = ""
      let settled = false
      const finish = (opt: Option.Option<Record<string, unknown>>) => {
        if (!settled) {
          settled = true
          resume(Effect.succeed(opt))
        }
      }
      const timer = setTimeout(() => {
        client.destroy()
        finish(Option.none())
      }, 1500)
      client.on("connect", () => {
        client.write(
          JSON.stringify({
            id: `${command}-${Date.now()}`,
            command,
            repoRoot,
            ...(files !== undefined ? { files } : {}),
          }) + "\n",
        )
      })
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8")
        const idx = buffer.indexOf("\n")
        if (idx !== -1) {
          clearTimeout(timer)
          const line = buffer.slice(0, idx).trim()
          client.end()
          const parsedOpt = Schema.decodeOption(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(line)
          finish(parsedOpt)
        }
      })
      client.on("error", () => {
        clearTimeout(timer)
        finish(Option.none())
      })
      return Effect.sync(() => {
        clearTimeout(timer)
        client.destroy()
      })
    })
  })

const handleVerify = (
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    if (process.env.HARNESS_USE_DAEMON === "1") {
      yield* tryQueryWarmDaemonSocket(repoRoot, "ping")
    }
    const requireOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!isIsolatedExternalWorkspace(repoRoot) &&
        options?.decisionLayer === undefined &&
        process.env.VITEST === undefined)
    if (requireOllama) {
      const ollamaOk = yield* ensureLocalOllamaReady()
      if (!ollamaOk) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is not running and could not be started automatically. Halting execution.",
        }
      }
    }
    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)

    const stubs = Array.from(fnIndex.bySpanName.values()).filter((fn) => fn.isStub)
    if (stubs.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: active stub() found in ${stubs.map((s) => s.spanName).join(", ")}`,
      }
    }

    const deltaFiles = resolveModifiedFilesSinceStampOrHead(repoRoot).filter(
      (f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && existsSync(join(repoRoot, f)),
    )
    if (deltaFiles.length > 0) {
      const astGateFiles = deltaFiles.map((relPath) => ({
        filePath: AstSourceFilePath.make(relPath),
        content: AstSourceContent.make(readFileSync(join(repoRoot, relPath), "utf-8")),
      }))
      const astReport = yield* AstGateCache.decide({
        files: astGateFiles,
        ruleVersion: HARNESS_GATE_RULE_VERSION,
        cacheFilePath: AstGateCache.resolveCachePath(repoRoot),
      })
      const enforcedAstViolations = astReport.violations.filter((v) => {
        if (
          v.rule === "effect-fn-dummy-void" ||
          v.rule === "switch-statement" ||
          v.rule === "match-run-statement" ||
          v.rule === "non-exhaustive-union-match" ||
          (v.rule === "discriminant-branching" && v.message.startsWith("Switch statement"))
        ) {
          return true
        }
        return (
          !v.file.startsWith("libs/harness/") &&
          !v.file.startsWith("apps/harness-") &&
          !v.file.startsWith("tools/")
        )
      })
      if (enforcedAstViolations.length > 0) {
        const msg = enforcedAstViolations
          .map((v) => `[${v.rule}] ${v.file}:${v.line}: ${v.message}`)
          .join("\n")
        return {
          exitCode: 1,
          stdout: "",
          stderr: `[GATE FAILURE] verify:ast-gates\n${msg}`,
        }
      }

      const rawModularDeltaFiles = deltaFiles.filter((f) => isModularPluginPath(f))
      let modularDeltaFiles = rawModularDeltaFiles
      if (modularDeltaFiles.length === 0 && existsSync(join(repoRoot, "libs", "harness", "gates", "src"))) {
        process.stderr.write(
          `[harness:verify] Warning: no modular gate delta files detected in ${repoRoot}; falling back to scanning all modular gate files.\n`,
        )
        modularDeltaFiles = collectModularPluginFiles(repoRoot).map((abs) =>
          relative(repoRoot, abs).replace(/\\/g, "/"),
        )
      }
      if (modularDeltaFiles.length > 0) {
        const pluginExit = yield* evaluateAllGatePlugins({
          filePaths: modularDeltaFiles.map((relPath) =>
            WorkspaceFilePath.make(join(repoRoot, relPath)),
          ),
          failOnViolation: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(GatePluginRegistryLive, WorkspaceFsLive)),
          Effect.exit,
        )
        if (pluginExit._tag === "Failure") {
          const errOpt = Cause.findErrorOption(pluginExit.cause)
          if (Option.isSome(errOpt) && errOpt.value._tag === "SelfDogfoodingViolationError") {
            const msg = errOpt.value.violations
              .map((v) => `[${v.rule}] ${v.file}:${v.line}: ${v.message}`)
              .join("\n")
            return {
              exitCode: 1,
              stdout: "",
              stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\n${msg}`,
            }
          }
          if (Option.isSome(errOpt) && errOpt.value._tag === "WorkspaceFsError") {
            return {
              exitCode: 1,
              stdout: "",
              stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\nFailed to read ${errOpt.value.filePath}: ${errOpt.value.reason}`,
            }
          }
          return {
            exitCode: 1,
            stdout: "",
            stderr: `[GATE FAILURE] verify:self-dogfooding-plugins\n${Cause.pretty(pluginExit.cause)}`,
          }
        }
      }
    }

    const graph = yield* extractGraphViaCompilerOverlay({ repoRoot }).pipe(
      Effect.provide(TsCompilerOverlayServiceLive),
      Effect.catchTag("TsCompilerOverlayError", () => extractTypeGraph({ repoRoot })),
    )
    const graphStubs: Array<string> = []
    for (const [, node] of Graph.nodes(graph.graph)) {
      if (node._tag === "EffectFn" && node.isStub) {
        graphStubs.push(node.spanName)
      }
    }
    if (graphStubs.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: active stub() found in ${Array.from(new Set(graphStubs)).join(", ")}`,
      }
    }

    const checkResult = checkEffectGraph(graph)
    if (!checkResult.ok) {
      const msg = checkResult.violations
        .map((v) => `[${v.rule}] ${v.message} (${v.path.join(" -> ")})`)
        .join("\n")
      recordFriction(options, {
        kind: "verify_failure",
        summary: checkResult.violations[0]?.rule ?? "graph-violation",
        detail: msg,
      })
      const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot))
      if (thrashing.stuck && thrashing.escalationMessage !== null) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `${thrashing.escalationMessage}\n${msg}`,
        }
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: msg,
      }
    }

    const governanceDocs = options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot)
    const ontologyInvariants = yield* decideOntologyInvariants({
      graph,
      governanceDocs,
    })
    if (!ontologyInvariants.clean) {
      const msg = ontologyInvariants.findings
        .map((f) => `[${f.kind}] ${f.nodeId}: ${f.message}`)
        .join("\n")
      recordFriction(options, {
        kind: "verify_failure",
        summary: ontologyInvariants.findings[0]?.kind ?? "ontology-invariants-failed",
        detail: msg,
      })
      const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot))
      if (thrashing.stuck && thrashing.escalationMessage !== null) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `${thrashing.escalationMessage}\n${msg}`,
        }
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: ontology invariants broken\n${msg}`,
      }
    }

    const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
    const snapshotPath = join(repoRoot, ".harness", "graph-snapshot.json")

    if (isIsolatedExternalWorkspace(repoRoot)) {
      saveGraphSnapshot(graph, snapshotPath)
      writeGraphHeadMeta(repoRoot)
      recordTelemetry(options, {
        surface: "cli",
        category: "graph_query",
        toolName: "omnigraph:sync-impl",
        outcome: "ok",
        durationMs: 1,
        engineSource: "local",
      })
    } else {
      yield* ensureLocalOmnigraphReady(repoRoot)
      const clusterRepoRoot = existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
        ? repoRoot
        : findWorkspaceRoot(repoRoot)

      const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
        repoRoot: clusterRepoRoot,
        branch: taskBranches.implBranch,
        from: taskBranches.mainBranch,
        snapshotPath,
      }).pipe(
        Effect.provide(OmnigraphSync.Live),
        Effect.orElseSucceed(() => ({ syncedToOmnigraph: false, snapshotPath, error: undefined })),
      )
      writeGraphHeadMeta(repoRoot)
      recordTelemetry(options, {
        surface: "cli",
        category: "graph_query",
        toolName: "omnigraph:sync-impl",
        outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
        durationMs: 1,
        engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "memory-fallback",
      })
      if (!syncRes.syncedToOmnigraph) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Verification failed: could not sync implementation graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`,
        }
      }
    }

    if (!options?.skipSubprocessVerify && existsSync(join(repoRoot, "package.json"))) {
      const leafFastPathEligible =
        deltaFiles.length > 0 && !isRootConfigOrSharedCoreChange(deltaFiles)
      const scopedFiles = leafFastPathEligible ? deltaFiles : undefined
      if (leafFastPathEligible) {
        for (const df of deltaFiles) {
          findTestsReaching(graph, df)
        }
      }
      const nxArgs = resolveNxAffectedArgs(repoRoot, ["verify"], scopedFiles)
      const subprocessErr = yield* Effect.try({
        try: () => {
          execFileSync("pnpm", nxArgs, {
            cwd: repoRoot,
            stdio: "pipe",
            env: { ...process.env, CI: "true" },
          })
          return null
        },
        catch: (cause) => formatSubprocessError(cause),
      }).pipe(Effect.catch((msg) => Effect.succeed(msg || "Verification subprocess failed")))

      if (subprocessErr !== null) {
        const triage = yield* triageFailure(subprocessErr).pipe(Effect.provide(decisionLayer))
        const formattedErr = `[GATE FAILURE] [triage:${triage.kind}] ${triage.hint}\n\nFAILED OUTPUT:\n${subprocessErr}`
        recordFriction(options, {
          kind: "verify_failure",
          summary: `verify:${triage.kind}`,
          detail: formattedErr,
        })
        const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot))
        if (thrashing.stuck && thrashing.escalationMessage !== null) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: `${thrashing.escalationMessage}\n\n${formattedErr}`,
          }
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr: formattedErr,
        }
      }
    }

    const pinnedSeed = parseDstSeedEnv(process.env["DST_SEED"])
    const dstTier = DstExecutionTier.make(process.env.CI === "true" ? "ci_full" : "fast_local")

    const dstTargets: Array<DstTargetMethodSpec> = []
    for (const [, node] of Graph.nodes(graph.graph)) {
      if (node._tag === "ServiceTag") {
        dstTargets.push({
          serviceTag: DstServiceTag.make(node.name || node.tagId),
          methodName: DstMethodName.make("execute"),
          declaredErrors: [DstErrorTag.make(`${node.name || node.tagId}Error`)],
        })
      }
    }
    if (dstTargets.length === 0) {
      dstTargets.push({
        serviceTag: DstServiceTag.make("HarnessVerificationService"),
        methodName: DstMethodName.make("verify"),
        declaredErrors: [DstErrorTag.make("HarnessVerificationError")],
      })
    }

    const dstSuiteResult = yield* runDstSeedSuite({
      tier: dstTier,
      pinnedSeed,
      stepCount: DstStepCount.make(8),
      targets: dstTargets,
    }).pipe(
      Effect.map((suite) => ({ _tag: "Ok" as const, suite })),
      Effect.catchTag("DstScheduleError", (err) =>
        Effect.succeed({ _tag: "Err" as const, err }),
      ),
    )

    if (dstSuiteResult._tag === "Err") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:dst-schedule\n${dstSuiteResult.err.reason ?? dstSuiteResult.err.message}`,
      }
    }
    const dstSuite = dstSuiteResult.suite

    const spanTracePath = join(repoRoot, ".harness", "span-trace.json")
    let recordedSpans: Array<SpanSample> = []
    if (existsSync(spanTracePath)) {
      const rawSpanJson = yield* Effect.try({
        try: () => readFileSync(spanTracePath, "utf-8"),
        catch: () => "",
      }).pipe(Effect.orElseSucceed(() => ""))
      if (rawSpanJson.length > 0) {
        const parsedOpt = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(
          rawSpanJson,
        )
        if (Option.isSome(parsedOpt)) {
          const parsed = parsedOpt.value
          if (Array.isArray(parsed)) {
            recordedSpans = parsed as Array<SpanSample>
          } else if (
            parsed !== null &&
            typeof parsed === "object" &&
            Array.isArray((parsed as Record<string, unknown>)["spans"])
          ) {
            recordedSpans = (parsed as Record<string, Array<SpanSample>>)["spans"]!
          }
        }
      }
    }

    const spanBudgetsResult = yield* decideSpanBudgets({
      spans: recordedSpans,
      causalityRules: [],
      failOnViolation: true,
    }).pipe(
      Effect.map(() => ({ _tag: "Ok" as const })),
      Effect.catchTag("SpanCausalityError", (err) =>
        Effect.succeed({ _tag: "Err" as const, err }),
      ),
    )

    const spanExitOpt = match(spanBudgetsResult)
      .with({ _tag: "Err" }, ({ err }) => ({
        exitCode: 1,
        stdout: "",
        stderr: `[GATE FAILURE] verify:span-budget\n${err.message}`,
      }))
      .with({ _tag: "Ok" }, () => undefined)
      .exhaustive()
    if (spanExitOpt !== undefined) {
      return spanExitOpt
    }

    const stamp = writeVerifyStamp(repoRoot, taskBranches.implBranch, {
      dstSeed: dstSuite.initialSeed,
      dstSeedsRun: dstSuite.seedsRun,
    })
    return { exitCode: 0, stdout: JSON.stringify(stamp), stderr: "" }
  })

const StopHookStdinSchema = Schema.Struct({
  fullyIdle: Schema.optional(Schema.Boolean),
  conversationId: Schema.optional(Schema.String),
  workspacePaths: Schema.optional(Schema.Array(Schema.String)),
  transcriptPath: Schema.optional(Schema.String),
})

const decodeStopHookStdin = Schema.decodeOption(Schema.fromJsonString(StopHookStdinSchema))

const TranscriptToolCallSchema = Schema.Struct({
  name: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const TranscriptStepSchema = Schema.Struct({
  source: Schema.String,
  content: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(TranscriptToolCallSchema)),
})

const decodeTranscriptStep = Schema.decodeOption(Schema.fromJsonString(TranscriptStepSchema))

const WRITE_TOOL_NAMES = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
])

const READ_ONLY_SHELL_PREFIXES = [
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "wc",
  "pwd",
  "echo",
  "which",
  "type",
  "stat",
  "file",
  "du",
  "df",
  "ps",
  "env",
  "printenv",
  "true",
  "false",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git remote",
  "git config --get",
  "git config --list",
]

const unwrapTranscriptStringArg = (val: unknown): string => {
  if (typeof val !== "string") return ""
  const trimmed = val.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  return trimmed
}

const isReadOnlyShellCommand = (rawCommand: string): boolean => {
  const cleaned = rawCommand
    .replace(/\b2>\s*\/dev\/null\b/g, "")
    .replace(/\b2>&1\b/g, "")
    .replace(/\b1?>\s*\/dev\/null\b/g, "")
    .trim()
  if (cleaned.length === 0) return true
  if (/(?:^|[^<>])>>?(?![>&])/.test(cleaned)) {
    return false
  }
  const segments = cleaned
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.replace(/^[()\s]+|[()\s]+$/g, "").trim())
    .filter((s) => s.length > 0)
  if (segments.length === 0) return true

  return segments.every((seg) => {
    const withoutEnv = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "").trim()
    return READ_ONLY_SHELL_PREFIXES.some(
      (prefix) =>
        withoutEnv === prefix ||
        withoutEnv.startsWith(`${prefix} `) ||
        withoutEnv.startsWith(`${prefix}\t`),
    )
  })
}

const isMutatingTranscriptToolCall = (
  tc: Schema.Schema.Type<typeof TranscriptToolCallSchema>,
): boolean => {
  if (WRITE_TOOL_NAMES.has(tc.name)) {
    const targetFile =
      unwrapTranscriptStringArg(tc.args?.TargetFile) ||
      unwrapTranscriptStringArg(tc.args?.file_path)
    if (
      targetFile.length > 0 &&
      (targetFile.includes("/.gemini/antigravity/brain/") ||
        targetFile.includes("/.gemini/antigravity/scratch/") ||
        targetFile.includes("/docs/rfcs/") ||
        targetFile.includes("/.harness/prompts/"))
    ) {
      return false
    }
    return true
  }
  if (tc.name === "run_command" || tc.name === "Bash") {
    const cmd =
      unwrapTranscriptStringArg(tc.args?.CommandLine) || unwrapTranscriptStringArg(tc.args?.command)
    return !isReadOnlyShellCommand(cmd)
  }
  if (tc.name === "call_mcp_tool") {
    const toolName = unwrapTranscriptStringArg(tc.args?.ToolName)
    return toolName === "mutate" || toolName === "load" || toolName.startsWith("branches_")
  }
  if (tc.name === "invoke_subagent" || tc.name === "Task") {
    const isReadOnlySubagentType = (typeName: string): boolean => {
      const normalized = typeName.trim().toLowerCase()
      return (
        normalized === "research" || normalized === "explore" || normalized.endsWith("-reviewer")
      )
    }
    const subagentTypeArg = unwrapTranscriptStringArg(tc.args?.subagent_type)
    if (subagentTypeArg.length > 0 && isReadOnlySubagentType(subagentTypeArg)) {
      return false
    }
    const rawSubagents = tc.args?.Subagents
    if (typeof rawSubagents === "string") {
      const unescaped = unwrapTranscriptStringArg(rawSubagents)
      const typeMatches = Array.from(unescaped.matchAll(/"TypeName"\s*:\s*"([^"]+)"/g))
      if (typeMatches.length > 0 && typeMatches.every((m) => isReadOnlySubagentType(m[1] ?? ""))) {
        return false
      }
    } else if (Array.isArray(rawSubagents) && rawSubagents.length > 0) {
      const allReadOnly = rawSubagents.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "TypeName" in item &&
          typeof item.TypeName === "string" &&
          isReadOnlySubagentType(item.TypeName),
      )
      if (allReadOnly) {
        return false
      }
    }
    return true
  }
  return false
}

const isSuccessfulVerifyTranscriptStep = (
  step: Schema.Schema.Type<typeof TranscriptStepSchema>,
): boolean => {
  const content = step.content
  if (typeof content !== "string" || content.length === 0) return false
  return (
    content.includes("The command exited with code 0.") &&
    content.includes('"taskBranch":') &&
    /"treeHash"\s*:\s*"[0-9a-f]{64}"/.test(content)
  )
}

const parseTranscriptSteps = (
  decoded?: Schema.Schema.Type<typeof StopHookStdinSchema>,
): ReadonlyArray<Schema.Schema.Type<typeof TranscriptStepSchema>> => {
  if (!decoded?.transcriptPath || !existsSync(decoded.transcriptPath)) {
    return []
  }
  const transcriptPath = decoded.transcriptPath
  const fullTranscriptPath = transcriptPath.replace(/transcript\.jsonl$/, "transcript_full.jsonl")
  const effectivePath =
    fullTranscriptPath !== transcriptPath && existsSync(fullTranscriptPath)
      ? fullTranscriptPath
      : transcriptPath

  return Effect.runSync(
    Effect.try({
      try: () => {
        const lines = readFileSync(effectivePath, "utf-8")
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
        const steps: Array<Schema.Schema.Type<typeof TranscriptStepSchema>> = []
        for (const line of lines) {
          const stepOpt = decodeTranscriptStep(line)
          if (Option.isSome(stepOpt)) {
            steps.push(stepOpt.value)
          }
        }
        return steps
      },
      catch: () => [],
    }).pipe(Effect.orElseSucceed(() => [])),
  )
}

const isReadOnlyStopTurn = (decoded?: Schema.Schema.Type<typeof StopHookStdinSchema>): boolean => {
  const steps = parseTranscriptSteps(decoded)
  if (steps.length === 0) return false
  let lastUserExplicitIdx = -1
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.source === "USER_EXPLICIT") {
      lastUserExplicitIdx = i
    }
  }
  if (lastUserExplicitIdx === -1) return false
  let firstStopHookBlockIdx = -1
  let hasRfcDocEdit = false
  for (let i = lastUserExplicitIdx + 1; i < steps.length; i++) {
    const content = steps[i]?.content
    if (typeof content === "string" && content.includes("Stop hook blocked termination:")) {
      firstStopHookBlockIdx = i
      break
    }
    for (const tc of steps[i]?.tool_calls ?? []) {
      const targetFile =
        unwrapTranscriptStringArg(tc.args?.TargetFile) ||
        unwrapTranscriptStringArg(tc.args?.file_path)
      if (targetFile.includes("/docs/rfcs/") || targetFile.includes("/.harness/prompts/")) {
        hasRfcDocEdit = true
      }
    }
  }
  if (hasRfcDocEdit) {
    return true
  }
  const endIdx = firstStopHookBlockIdx !== -1 ? firstStopHookBlockIdx : steps.length
  for (let i = lastUserExplicitIdx + 1; i < endIdx; i++) {
    const step = steps[i]
    if (!step?.tool_calls) continue
    for (const tc of step.tool_calls) {
      if (isMutatingTranscriptToolCall(tc)) {
        return false
      }
    }
  }
  return true
}

const hasVerifiedSinceLastMutation = (
  decoded?: Schema.Schema.Type<typeof StopHookStdinSchema>,
): boolean => {
  const steps = parseTranscriptSteps(decoded)
  if (steps.length === 0) return false
  let lastUserExplicitIdx = -1
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.source === "USER_EXPLICIT") {
      lastUserExplicitIdx = i
    }
  }
  if (lastUserExplicitIdx === -1) return false
  let lastMutatingIdx = -1
  let lastVerifySuccessIdx = -1
  for (let i = lastUserExplicitIdx + 1; i < steps.length; i++) {
    const step = steps[i]
    if (!step) continue
    if (isSuccessfulVerifyTranscriptStep(step)) {
      lastVerifySuccessIdx = i
    }
    if (step.tool_calls) {
      for (const tc of step.tool_calls) {
        if (isMutatingTranscriptToolCall(tc)) {
          lastMutatingIdx = i
        }
      }
    }
  }
  return lastVerifySuccessIdx !== -1 && lastVerifySuccessIdx > lastMutatingIdx
}

const isSubagentStopContext = (
  repoRoot: string,
  decoded?: Schema.Schema.Type<typeof StopHookStdinSchema>,
): boolean => {
  if (
    process.env.HARNESS_SUBAGENT === "1" ||
    repoRoot.includes("/.gemini/antigravity/worktrees/") ||
    repoRoot.includes("/subagent-")
  ) {
    return true
  }
  if (
    decoded?.workspacePaths?.some(
      (p) => p.includes("/.gemini/antigravity/worktrees/") || p.includes("/subagent-"),
    )
  ) {
    return true
  }
  if (decoded?.transcriptPath && existsSync(decoded.transcriptPath)) {
    const transcriptPath = decoded.transcriptPath
    const isSubagentTranscript = Effect.runSync(
      Effect.try({
        try: () => {
          const lines = readFileSync(transcriptPath, "utf-8")
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
          const firstLine = lines[0]
          if (firstLine === undefined) {
            return false
          }
          const firstStepOpt = decodeTranscriptStep(firstLine)
          if (
            Option.isNone(firstStepOpt) ||
            firstStepOpt.value.source !== "SYSTEM" ||
            !firstStepOpt.value.content?.includes("[Message]")
          ) {
            return false
          }
          for (const line of lines) {
            const stepOpt = decodeTranscriptStep(line)
            if (Option.isSome(stepOpt) && stepOpt.value.source === "USER_EXPLICIT") {
              return false
            }
          }
          return true
        },
        catch: (err) => {
          process.stderr.write(
            `[harness] Warning: failed to inspect transcript at ${transcriptPath}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          )
          return false
        },
      }).pipe(Effect.orElseSucceed(() => false)),
    )
    if (isSubagentTranscript) {
      return true
    }
  }
  return false
}

const handleDone = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const isAntigravity = argv.includes("--format=antigravity")
    const blockDecision = isAntigravity ? "continue" : "block"

    let rawStdin = options?.stdin
    if (rawStdin === undefined && !process.stdin.isTTY) {
      rawStdin = yield* Effect.try({
        try: () => readFileSync(0, "utf8"),
        catch: () => "",
      }).pipe(Effect.orElseSucceed(() => ""))
    }
    let decodedStdin: Schema.Schema.Type<typeof StopHookStdinSchema> | undefined
    if (rawStdin) {
      const decoded = decodeStopHookStdin(rawStdin)
      if (Option.isSome(decoded)) {
        decodedStdin = decoded.value
        if (decoded.value.fullyIdle === false) {
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            telemetryDetail: "fullyIdle=false",
          }
        }
      }
    }

    if (isSubagentStopContext(repoRoot, decodedStdin)) {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
        stderr: "",
        telemetryDetail: "subagent=true",
      }
    }

    if (isReadOnlyStopTurn(decodedStdin)) {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
        stderr: "",
        telemetryDetail: "readOnly=true",
      }
    }

    // 1. Stamp check
    const stampCheck = checkVerifyStamp(repoRoot)
    if (!stampCheck.valid) {
      if (hasVerifiedSinceLastMutation(decodedStdin)) {
        return {
          exitCode: 0,
          stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
          stderr: "",
          telemetryDetail: "completed",
        }
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: blockDecision,
          reason: stampCheck.reason,
        }),
        stderr: "",
      }
    }

    // 2. Graph diff check
    let planGraph = options?.planGraph
    let implGraph = options?.implGraph
    if (!planGraph && !implGraph) {
      const planPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
      const implPath = join(repoRoot, ".harness", "graph-snapshot.json")
      if (existsSync(planPath) && existsSync(implPath)) {
        planGraph = yield* loadGraphSnapshotEffect(planPath).pipe(Effect.orDie)
        implGraph = yield* loadGraphSnapshotEffect(implPath).pipe(Effect.orDie)
      }
    }
    if (planGraph && implGraph) {
      const diff = diffPlanAndImplGraphs(planGraph, implGraph)
      if (!diff.ok) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: diff.reasons.join("; "),
          }),
          stderr: "",
        }
      }
    }

    // 3. Plan step coverage check
    if (options?.planSteps && options.planSteps.length > 0) {
      for (const step of options.planSteps) {
        const stepRes = yield* checkPlanStepCoverage(step).pipe(Effect.provide(decisionLayer))
        if (!stepRes.covered) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: blockDecision,
              reason: stepRes.reason,
            }),
            stderr: "",
          }
        }
      }
    }

    // 4. Diff and merge branch impl into main in Omnigraph (hard gate)
    if (isIsolatedExternalWorkspace(repoRoot)) {
      writeGraphHeadMeta(repoRoot)
      recordTelemetry(options, {
        surface: isAntigravity ? "hook" : "cli",
        category: "graph_query",
        toolName: "omnigraph:merge-main",
        outcome: "ok",
        durationMs: 1,
        engineSource: "local",
      })
    } else {
      yield* ensureLocalOmnigraphReady(repoRoot)
      const clusterRepoRoot = existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
        ? repoRoot
        : findWorkspaceRoot(repoRoot)
      const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
      yield* diffOmnigraphBranches({
        repoRoot: clusterRepoRoot,
        source: taskBranches.implBranch,
        target: taskBranches.planBranch,
      }).pipe(
        Effect.provide(OmnigraphSync.Live),
        Effect.orElseSucceed(() => Option.none()),
      )

      const merged = yield* mergeOmnigraphBranch({
        repoRoot: clusterRepoRoot,
        source: taskBranches.implBranch,
        target: taskBranches.mainBranch,
        cleanupBranches: [taskBranches.implBranch, taskBranches.planBranch],
      }).pipe(
        Effect.provide(OmnigraphSync.Live),
        Effect.orElseSucceed(() => false),
      )
      writeGraphHeadMeta(repoRoot)
      recordTelemetry(options, {
        surface: isAntigravity ? "hook" : "cli",
        category: "graph_query",
        toolName: "omnigraph:merge-main",
        outcome: merged ? "ok" : "fail",
        durationMs: 1,
        engineSource: merged ? "omnigraph" : "memory-fallback",
      })
      if (!merged) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: `Omnigraph branch merge (${taskBranches.implBranch} -> ${taskBranches.mainBranch}) failed`,
          }),
          stderr: "",
        }
      }
    }

    // 5. All checks passed
    if (options?.repoRoot !== undefined || process.env.VITEST === undefined) {
      const report = buildSessionReport({
        events: readTelemetryEvents(repoRoot),
        frictionEvents: readFrictionEvents(repoRoot),
        stampValid: true,
      })
      writeSessionReportFiles(repoRoot, report)
    }

    return {
      exitCode: 0,
      stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
      stderr: "",
      telemetryDetail: "completed",
    }
  })

const LockJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

function unlockOmnigraphClusterIfNeeded(
  omnigraphBin: string,
  clusterRootDir: string,
  applyOutput?: string,
): void {
  const lockIds = new Set<string>()
  if (applyOutput) {
    const match = applyOutput.match(/Admission lock:\s*([A-Za-z0-9_-]+)/)
    if (match?.[1]) {
      lockIds.add(match[1])
    }
  }
  const lockPath = join(clusterRootDir, "__cluster", "lock.json")
  if (existsSync(lockPath)) {
    Effect.runSync(
      Effect.try({
        try: () => {
          const raw = readFileSync(lockPath, "utf-8")
          const parsedOpt = Schema.decodeOption(LockJsonSchema)(raw)
          if (Option.isSome(parsedOpt)) {
            const parsed = parsedOpt.value
            for (const key of ["lock_id", "id", "lockId", "holder_id"]) {
              const val = parsed[key]
              if (typeof val === "string" && val.length > 0) {
                lockIds.add(val)
              }
            }
          }
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
    )
  }
  for (const lockId of lockIds) {
    Effect.runSync(
      Effect.try({
        try: () => {
          execFileSync(
            omnigraphBin,
            ["cluster", "force-unlock", lockId, "--target", clusterRootDir],
            { stdio: "ignore" },
          )
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
    )
  }
}

function checkOmnigraphServerReady(baseUrl: string): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: () =>
      globalThis
        .fetch(`${baseUrl}/readyz`, {
          method: "GET",
          signal: AbortSignal.timeout(3000),
        })
        .then((r) => {
          if (r.status !== 200 || r.headers.get("Omnigraph-Http-Api") !== "0.14") {
            return Promise.resolve(false)
          }
          return r.json().then((rawBody: unknown) => {
            if (typeof rawBody !== "object" || rawBody === null) {
              return false
            }
            const body = rawBody as {
              readonly ready?: boolean
              readonly status?: string
              readonly ready_graph_count?: number
            }
            return (
              (body.ready === true || body.status === "serving") &&
              (body.ready_graph_count ?? 0) >= 1
            )
          })
        })
        .catch(() => false),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))
}

function computeOmnigraphConfigStamp(configDir: string): string {
  const files = ["cluster.yaml", "schema.pg", "queries/harness.gq"]
  return files
    .map((f) => {
      const p = join(configDir, f)
      return existsSync(p) ? readFileSync(p, "utf-8") : ""
    })
    .join("\n---\n")
}

export const buildOmnigraphClusterKillArgs = (
  clusterRootDir: string,
): readonly [string, ReadonlyArray<string>] => [
  "pkill",
  ["-f", `omnigraph-server.*--cluster file://${clusterRootDir}`],
]

const OmnigraphServerMetaSchema = Schema.Struct({
  pid: Schema.optional(Schema.Finite),
  port: Schema.optional(Schema.Finite),
  baseUrl: Schema.optional(Schema.String),
  canonicalRepoRoot: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
})

type OmnigraphServerMeta = Schema.Schema.Type<typeof OmnigraphServerMetaSchema>

const decodeOmnigraphServerMeta = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema),
)

function ensureLocalOmnigraphReady(repoRoot: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const clusterRepoRoot = existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
      ? repoRoot
      : findWorkspaceRoot(repoRoot)
    const canonicalRepoRoot = resolveCanonicalRepoRoot(clusterRepoRoot)
    const clusterRootDir = resolveOmnigraphClusterDir(clusterRepoRoot)
    const defaultPort = deriveRepoOmnigraphPort(canonicalRepoRoot)

    let serverMeta: OmnigraphServerMeta | undefined
    const serverJsonPath = join(clusterRootDir, "server.json")
    if (existsSync(serverJsonPath)) {
      const decodedMetaOpt = yield* Effect.try({
        try: () => readFileSync(serverJsonPath, "utf-8"),
        catch: () => "",
      }).pipe(
        Effect.flatMap((raw) => Effect.fromOption(decodeOmnigraphServerMeta(raw))),
        Effect.option,
      )
      if (Option.isSome(decodedMetaOpt)) {
        serverMeta = decodedMetaOpt.value
      }
    }

    const explicitEnvUrl =
      process.env.OMNIGRAPH_URL && process.env.OMNIGRAPH_URL !== "http://127.0.0.1:8080"
        ? process.env.OMNIGRAPH_URL
        : undefined
    const targetBaseUrl =
      explicitEnvUrl ??
      (serverMeta?.canonicalRepoRoot === canonicalRepoRoot && serverMeta?.baseUrl
        ? serverMeta.baseUrl
        : `http://127.0.0.1:${defaultPort}`)

    const configDir = join(clusterRepoRoot, "libs", "harness", "graph")
    const stampPath = join(clusterRootDir, ".config-stamp")
    const expectedStamp = computeOmnigraphConfigStamp(configDir)
    const currentStamp = existsSync(stampPath) ? readFileSync(stampPath, "utf-8") : ""
    const configDrifted = currentStamp !== expectedStamp

    if (configDrifted) {
      if (typeof serverMeta?.pid === "number") {
        yield* Effect.try({
          try: () => {
            process.kill(serverMeta.pid!, "SIGTERM")
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined))
      }
      yield* Effect.try({
        try: () => {
          const [killBin, killArgs] = buildOmnigraphClusterKillArgs(clusterRootDir)
          execFileSync(killBin, killArgs as string[], { stdio: "ignore" })
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
      yield* Effect.sleep("300 millis")
      yield* Effect.try({
        try: () => {
          rmSync(clusterRootDir, { recursive: true, force: true })
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    } else {
      const isReadyCandidate =
        explicitEnvUrl !== undefined || serverMeta?.canonicalRepoRoot === canonicalRepoRoot
      if (isReadyCandidate) {
        const alreadyReady = yield* checkOmnigraphServerReady(targetBaseUrl)
        if (alreadyReady) {
          return true
        }
      }
    }

    const homeBin = join(process.env.HOME ?? "/root", ".local", "bin")
    const omnigraphBin = join(homeBin, "omnigraph")
    const omnigraphServerBin = join(homeBin, "omnigraph-server")

    if (!existsSync(omnigraphBin) || !existsSync(omnigraphServerBin)) {
      yield* Effect.try({
        try: () => {
          execFileSync(
            "bash",
            [
              "-c",
              "curl -fsSL https://raw.githubusercontent.com/ModernRelay/omnigraph/main/scripts/install.sh | VERSION=v0.14.0 bash",
            ],
            { stdio: "inherit" },
          )
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
    }

    if (!existsSync(omnigraphBin) || !existsSync(omnigraphServerBin)) {
      return false
    }

    yield* Effect.try({
      try: () => {
        if (!existsSync(clusterRootDir)) {
          mkdirSync(clusterRootDir, { recursive: true })
        }
        unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)

        const graphOmniDir = join(clusterRootDir, "graphs", "harness.omni")
        if (!existsSync(graphOmniDir)) {
          const out = execFileSync(
            omnigraphBin,
            [
              "cluster",
              "apply",
              "--target",
              clusterRootDir,
              "--config",
              configDir,
              "--as",
              "harness-cli",
              "--json",
            ],
            {
              cwd: clusterRepoRoot,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          )
          unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir, out)
          writeFileSync(stampPath, expectedStamp, "utf-8")
        }
        unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)

        const bindHostPort =
          targetBaseUrl.match(/^https?:\/\/([^/]+)/)?.[1] ?? `127.0.0.1:${defaultPort}`

        const child = spawn(
          omnigraphServerBin,
          ["--cluster", `file://${clusterRootDir}`, "--bind", bindHostPort, "--unauthenticated"],
          {
            cwd: clusterRepoRoot,
            detached: true,
            stdio: "ignore",
          },
        )
        child.unref()

        if (child.pid !== undefined) {
          writeFileSync(
            join(clusterRootDir, "server.json"),
            JSON.stringify(
              {
                pid: child.pid,
                port: defaultPort,
                baseUrl: targetBaseUrl,
                canonicalRepoRoot,
                updatedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
            "utf-8",
          )
        }
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))

    // Wait up to 3 seconds for omnigraph-server /readyz
    for (let i = 0; i < 30; i++) {
      const isReady = yield* checkOmnigraphServerReady(targetBaseUrl)
      if (isReady) {
        return true
      }
      yield* Effect.sleep("100 millis")
    }

    return false
  })
}

export interface OllamaReadinessOptions {
  readonly baseUrl?: string | undefined
  readonly spawnOllama?: (() => void) | undefined
  readonly maxRetries?: number | undefined
  readonly retryDelayMs?: number | undefined
}

export function checkOllamaServerReady(
  baseUrl: string = process.env.HARNESS_OLLAMA_URL ??
    process.env.OLLAMA_HOST ??
    "http://127.0.0.1:11434",
): Effect.Effect<boolean> {
  const normalizedUrl = baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`
  return Effect.tryPromise({
    try: () =>
      globalThis
        .fetch(`${normalizedUrl.replace(/\/$/, "")}/api/tags`, {
          method: "GET",
          signal: AbortSignal.timeout(2000),
        })
        .then((r) => {
          if (r.status !== 200) {
            return Promise.resolve(false)
          }
          return r.json().then((rawBody: unknown) => {
            if (typeof rawBody !== "object" || rawBody === null) {
              return false
            }
            const body = rawBody as {
              readonly models?: ReadonlyArray<{
                readonly name?: string
                readonly model?: string
              }>
            }
            if (!Array.isArray(body.models)) {
              return false
            }
            return body.models.some(
              (m) =>
                (typeof m.name === "string" && m.name.startsWith("clef-flash")) ||
                (typeof m.model === "string" && m.model.startsWith("clef-flash")),
            )
          })
        })
        .catch(() => false),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))
}

export function ensureLocalOllamaReady(opts?: OllamaReadinessOptions): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const customUrl = process.env.HARNESS_OLLAMA_URL
    const baseUrl =
      opts?.baseUrl ?? customUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"
    const alreadyReady = yield* checkOllamaServerReady(baseUrl)
    if (alreadyReady) {
      return true
    }

    yield* Effect.try({
      try: () => {
        if (opts?.spawnOllama !== undefined) {
          opts.spawnOllama()
        } else if (customUrl === undefined) {
          const child = spawn("ollama", ["serve"], {
            detached: true,
            stdio: "ignore",
          })
          child.unref()
        }
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))

    const maxRetries = opts?.maxRetries ?? (customUrl !== undefined ? 2 : 25)
    const retryDelayMs = opts?.retryDelayMs ?? (customUrl !== undefined ? 10 : 200)
    for (let i = 0; i < maxRetries; i++) {
      yield* Effect.sleep(`${retryDelayMs} millis`)
      const isReady = yield* checkOllamaServerReady(baseUrl)
      if (isReady) {
        return true
      }
    }

    return false
  })
}

const handleDoctorOrSession = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const isAntigravity = argv.includes("--format=antigravity")
    const nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10)
    const nodeOk = nodeMajor >= 24

    const harnessDir = resolveHarnessStateDir(repoRoot)
    const snapshotDirOk = yield* Effect.try({
      try: () => {
        if (!existsSync(harnessDir)) {
          mkdirSync(harnessDir, { recursive: true })
        }
        return true
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))

    const isolatedExternal = isIsolatedExternalWorkspace(repoRoot)
    const omnigraphInitialized = isolatedExternal
      ? true
      : yield* ensureLocalOmnigraphReady(repoRoot)

    const requireLiveOllama =
      process.env.HARNESS_REQUIRE_OLLAMA === "1" ||
      (!isolatedExternal &&
        options?.decisionLayer === undefined &&
        process.env.VITEST === undefined)
    const ollamaReady = requireLiveOllama ? yield* ensureLocalOllamaReady() : true

    const planPath = join(harnessDir, "plan-graph-snapshot.json")
    const implPath = join(harnessDir, "graph-snapshot.json")

    const headState = resolveGitHeadState(repoRoot)
    const recordedMeta = readGraphHeadMeta(repoRoot)
    if (!isolatedExternal || recordedMeta !== null) {
      const reconcileDecision = yield* decideOmnigraphReconcile({
        snapshotExists: existsSync(implPath),
        recordedHeadSha: recordedMeta?.headSha ?? null,
        currentHeadSha: headState.headSha,
        recordedGitBranch: recordedMeta?.gitBranch ?? null,
        currentGitBranch: headState.gitBranch,
      })
      if (reconcileDecision.needsReconcile) {
        const reconciledGraph = yield* extractWorkspaceTypeAwareGraph(repoRoot)
        if (isolatedExternal) {
          saveGraphSnapshot(reconciledGraph, implPath)
          writeGraphHeadMeta(repoRoot, headState)
        } else {
          const clusterRepoRoot = existsSync(
            join(repoRoot, "libs", "harness", "graph", "cluster.yaml"),
          )
            ? repoRoot
            : findWorkspaceRoot(repoRoot)
          yield* syncToOmnigraphAndSnapshot(reconciledGraph, {
            repoRoot: clusterRepoRoot,
            branch: reconcileDecision.targetOmnigraphBranch,
            from: "main",
            snapshotPath: implPath,
          }).pipe(
            Effect.provide(OmnigraphSync.Live),
            Effect.orElseSucceed(() => ({
              syncedToOmnigraph: false,
              snapshotPath: implPath,
              error: undefined,
            })),
          )
          writeGraphHeadMeta(repoRoot, headState)
        }
      }
    }

    const workspaceRoot = findWorkspaceRoot()
    const tsconfigBasePath = existsSync(join(repoRoot, "tsconfig.base.json"))
      ? join(repoRoot, "tsconfig.base.json")
      : join(workspaceRoot, "tsconfig.base.json")
    const tsgoPkgPath = existsSync(
      join(repoRoot, "node_modules", "@effect", "tsgo", "package.json"),
    )
      ? join(repoRoot, "node_modules", "@effect", "tsgo", "package.json")
      : join(workspaceRoot, "node_modules", "@effect", "tsgo", "package.json")
    const effectLspOk = yield* Effect.try({
      try: () => {
        if (!existsSync(tsconfigBasePath) || !existsSync(tsgoPkgPath)) {
          return false
        }
        const tsconfigRaw = readFileSync(tsconfigBasePath, "utf-8")
        return tsconfigRaw.includes("@effect/language-service")
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false))

    const modelWarm = isAntigravity
      ? ollamaReady
      : ollamaReady &&
        Option.isSome(
          yield* DecisionModel.decide(IdiomRouterV1, {
            input: { planStep: "Initialize session" },
          }).pipe(
            Effect.timeoutOption("10 seconds"),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeedNone,
            ),
            Effect.provide(decisionLayer),
          ),
        )

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
    const activeStubs = Array.from(fnIndex.bySpanName.values())
      .filter((fn) => fn.isStub)
      .map((fn) => fn.spanName)

    let missingPlannedFns: ReadonlyArray<string> = []
    if (existsSync(planPath) && existsSync(implPath)) {
      const planGraph = yield* loadGraphSnapshotEffect(planPath).pipe(Effect.orDie)
      const implGraph = yield* loadGraphSnapshotEffect(implPath).pipe(Effect.orDie)
      const diff = diffPlanAndImplGraphs(planGraph, implGraph)
      if (!diff.ok) {
        missingPlannedFns = diff.reasons
      }
    }

    const stampCheck = checkVerifyStamp(repoRoot)
    const hasPlanOrStamp = existsSync(planPath) || existsSync(join(harnessDir, "verify-stamp.json"))
    const effectiveStampValid = hasPlanOrStamp ? stampCheck.valid : true
    const stampReason = !stampCheck.valid ? stampCheck.reason : undefined
    const rawFrictionEvents = readFrictionEvents(repoRoot)
    const telemetryEvents = readTelemetryEvents(repoRoot)
    const scoped = scopeSessionReportInput({
      events: telemetryEvents,
      frictionEvents: rawFrictionEvents,
    })
    const frictionClusters = summarizeFrictionEvents(scoped.frictionEvents)
    const loopThrashing = checkLoopThrashing(scoped.frictionEvents)

    const handoff = buildSessionHandoff({
      stampValid: effectiveStampValid,
      stampReason,
      activeStubs,
      missingPlannedFns,
      frictionClusters,
      loopThrashing,
    })

    const telemetryReport = buildSessionReport({
      events: telemetryEvents,
      frictionEvents: rawFrictionEvents,
      stampValid: effectiveStampValid,
    })

    const ok = nodeOk && snapshotDirOk && effectLspOk && omnigraphInitialized && ollamaReady

    if (isAntigravity) {
      const injected: Array<string> = []
      if (!ollamaReady) {
        injected.push(
          "[CRITICAL HARNESS BLOCKER] Key component Ollama (clef-flash DecisionModel) is offline and could not be started automatically. Stop all implementation immediately and inform the user.",
        )
      }
      if (handoff.handoffMessage !== null) {
        injected.push(handoff.handoffMessage)
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          injectSteps: injected,
        }),
        stderr: "",
      }
    }

    return {
      exitCode: ok ? 0 : 1,
      stdout: JSON.stringify({
        nodeVersion: process.versions.node,
        nodeOk,
        snapshotDirOk,
        effectLspOk,
        omnigraphInitialized,
        ollamaReady,
        modelWarm,
        handoff,
        telemetry: {
          totalEvents: telemetryReport.totalEvents,
          healthScore: telemetryReport.healthScore,
          grade: telemetryReport.grade,
        },
      }),
      stderr: ok
        ? ""
        : `Doctor check failed: nodeOk=${nodeOk}, snapshotDirOk=${snapshotDirOk}, effectLspOk=${effectLspOk}, omnigraphInitialized=${omnigraphInitialized}, ollamaReady=${ollamaReady}`,
    }
  })

const handleGc = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const strict = argv.includes("--strict")
    const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot)
    const hasPatternsDir = existsSync(join(repoRoot, "agent-patterns"))
    const governanceDocs = loadGovernanceDocsFromDisk(repoRoot)
    const report = scanGraphEntropy(graph, {
      expectedPatterns: hasPatternsDir ? IDIOM_BLOCKS : undefined,
      checkUntestedDomainFns: true,
      checkDeciderPropertyTests: true,
      governanceDocs,
    })
    const findings = strict
      ? [...report.findings, ...scanWorkspacePackageHygiene(repoRoot)]
      : report.findings
    const finalReport = {
      clean: findings.length === 0,
      findings,
    }
    return {
      exitCode: strict && !finalReport.clean ? 1 : 0,
      stdout: JSON.stringify(finalReport),
      stderr: "",
    }
  })

const handleMutate = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const scopeArg = argv.find((arg) => arg.startsWith("--scope="))
    const scope = scopeArg ? scopeArg.slice("--scope=".length) : undefined

    const report = runDomainMutationSuite(repoRoot, { scope })
    return {
      exitCode: !report.passed ? 1 : 0,
      stdout: JSON.stringify(report),
      stderr: "",
    }
  })

const handleBench = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const iterationsArg = argv.find((a) => a.startsWith("--iterations="))
    const parsedIter = iterationsArg ? Number(iterationsArg.slice("--iterations=".length)) : 3
    const iterations = Number.isFinite(parsedIter) && parsedIter >= 1 ? Math.floor(parsedIter) : 3

    const budgetArg = argv.find((a) => a.startsWith("--budget-ms="))
    const parsedBudget = budgetArg ? Number(budgetArg.slice("--budget-ms=".length)) : undefined
    const customBudgetMs =
      parsedBudget !== undefined && Number.isFinite(parsedBudget) && parsedBudget >= 0
        ? LatencyMillis.make(parsedBudget)
        : undefined

    const benchRelFile = existsSync(
      join(repoRoot, "libs", "harness", "gates", "src", "bench-check.ts"),
    )
      ? "libs/harness/gates/src/bench-check.ts"
      : "libs/sample/domain/src/index.ts"
    const sampleFilePath = join(repoRoot, benchRelFile)
    const sampleContent = existsSync(sampleFilePath)
      ? readFileSync(sampleFilePath, "utf-8")
      : "export const x = 1\n"

    // 1. Measure cold and warm extractTypeGraph (with signature-preserving body overlay)
    clearWarmProgramSessions()
    const session = getOrCreateWarmProgramSession(repoRoot)
    const coldExtractStart = performance.now()
    const initialGraph = yield* extractTypeGraph({ repoRoot, session })
    const coldExtractMs = Math.max(0, performance.now() - coldExtractStart)

    // Ensure ts-morph Program in session is primed for the target file when hydrated from disk cache
    yield* extractTypeGraph({
      repoRoot,
      session,
      overlays: {
        [benchRelFile]: `${sampleContent}\n// warm-prime\n`,
      },
    })

    const warmExtractSamples: Array<number> = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      yield* extractTypeGraph({
        repoRoot,
        session,
        overlays: {
          [benchRelFile]: `${sampleContent}\n// warm-bench-${i}\n`,
        },
      })
      warmExtractSamples.push(Math.max(0, performance.now() - t0))
    }

    let stageError: string | undefined = undefined

    // 2. Measure DatalogSession.stepDelta on warm DatalogSession
    const datalogSamples: Array<number> = []
    const datalogLayer = DatalogSession.layer(initialGraph)
    yield* Effect.gen(function* () {
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now()
        yield* stepDatalogFileDelta({
          filePath: DatalogFilePath.make(benchRelFile),
          nextGraph: initialGraph,
        })
        datalogSamples.push(Math.max(0, performance.now() - t0))
      }
    }).pipe(
      Effect.provide(datalogLayer),
      Effect.catch((err) =>
        Effect.sync(() => {
          stageError = `DatalogSession.stepDelta failed: ${String(err)}`
        }),
      ),
    )

    if (stageError !== undefined) {
      return {
        exitCode: 1,
        stdout: JSON.stringify({ overallStatus: "failed", error: stageError }),
        stderr: stageError,
      }
    }

    // 3. Measure AstGateCache (cold prime + warm hits)
    const cacheFilePath = AstGateCache.resolveCachePath(repoRoot)
    yield* AstGateCache.decide({
      files: [
        {
          filePath: AstSourceFilePath.make(benchRelFile),
          content: AstSourceContent.make(sampleContent),
        },
      ],
      ruleVersion: HARNESS_GATE_RULE_VERSION,
      cacheFilePath,
    })

    const warmAstSamples: Array<number> = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      yield* AstGateCache.decide({
        files: [
          {
            filePath: AstSourceFilePath.make(benchRelFile),
            content: AstSourceContent.make(sampleContent),
          },
        ],
        ruleVersion: HARNESS_GATE_RULE_VERSION,
        cacheFilePath,
      })
      warmAstSamples.push(Math.max(0, performance.now() - t0))
    }

    // 4. Measure GraphRewrite.decide
    const rewriteSamples: Array<number> = []
    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now()
      yield* decideGraphRewrite(initialGraph, "cleanup", undefined, { maxPhaseSteps: 2 }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            stageError = `GraphRewrite.decide failed: ${String(err)}`
          }),
        ),
      )
      if (stageError !== undefined) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({ overallStatus: "failed", error: stageError }),
          stderr: stageError,
        }
      }
      rewriteSamples.push(Math.max(0, performance.now() - t0))
    }

    const measurements = [
      buildStageLatencyMeasurement(
        BenchStageName.make("extractTypeGraph.warm"),
        warmExtractSamples,
      ),
      buildStageLatencyMeasurement(BenchStageName.make("DatalogSession.stepDelta"), datalogSamples),
      buildStageLatencyMeasurement(BenchStageName.make("AstGateCache.warm"), warmAstSamples),
      buildStageLatencyMeasurement(BenchStageName.make("GraphRewrite.decide"), rewriteSamples),
    ]

    const effectiveBudgets =
      customBudgetMs !== undefined
        ? DEFAULT_STAGE_LATENCY_BUDGETS.map((b) => ({
            stage: b.stage,
            p50BudgetMs: customBudgetMs,
            p95BudgetMs: customBudgetMs,
          }))
        : DEFAULT_STAGE_LATENCY_BUDGETS

    const benchExit = yield* Effect.exit(
      decideHarnessBench({
        measurements,
        budgets: effectiveBudgets,
      }),
    )

    return match(benchExit)
      .with({ _tag: "Failure" }, (failure) => {
        const errOpt = Cause.findErrorOption(failure.cause)
        const { violations, stderrMsg } = match(errOpt)
          .with({ _tag: "Some" }, ({ value }) =>
            value instanceof LatencySloViolationError
              ? {
                  violations: value.violations,
                  stderrMsg: `[LatencySloViolationError] ${value.violations.length} stage(s) exceeded latency budget`,
                }
              : {
                  violations: [],
                  stderrMsg: "Benchmark SLO evaluation failed",
                },
          )
          .with({ _tag: "None" }, () => ({
            violations: [],
            stderrMsg: "Benchmark SLO evaluation failed",
          }))
          .exhaustive()
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            overallStatus: "failed",
            coldExtractMs: LatencyMillis.make(Math.round(coldExtractMs * 100) / 100),
            measurements,
            violations,
          }),
          stderr: stderrMsg,
        }
      })
      .with({ _tag: "Success" }, (success) => ({
        exitCode: 0,
        stdout: JSON.stringify({
          overallStatus: "passed",
          ...success.value,
          coldExtractMs: LatencyMillis.make(Math.round(coldExtractMs * 100) / 100),
          measurements,
        }),
        stderr: "",
      }))
      .exhaustive()
  })

export const handleIngest = Effect.fn("Harness.ingestWorkspace")(function* (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.fn.Return<CliResult> {
  const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
  const isAntigravity = argv.includes("--format=antigravity")
  const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
  const harnessDir = resolveHarnessStateDir(repoRoot)
  const snapshotPath = join(harnessDir, "graph-snapshot.json")
  const headState = resolveGitHeadState(repoRoot)
  const recordedMeta = readGraphHeadMeta(repoRoot)
  const reconcileDecision = yield* decideOmnigraphReconcile({
    snapshotExists: existsSync(snapshotPath),
    recordedHeadSha: recordedMeta?.headSha ?? null,
    currentHeadSha: headState.headSha,
    recordedGitBranch: recordedMeta?.gitBranch ?? null,
    currentGitBranch: headState.gitBranch,
  })

  if (!isAntigravity || reconcileDecision.needsReconcile) {
    const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
    const targetBranch =
      headState.gitBranch === null ||
      headState.gitBranch === "main" ||
      headState.gitBranch === "master"
        ? taskBranches.mainBranch
        : taskBranches.implBranch

    if (isIsolatedExternalWorkspace(repoRoot)) {
      saveGraphSnapshot(graph, snapshotPath)
      writeGraphHeadMeta(repoRoot, headState)
      return {
        exitCode: 0,
        stdout: isAntigravity
          ? JSON.stringify({})
          : JSON.stringify({
              indexedFns: fnIndex.bySpanName.size,
              syncedToOmnigraph: false,
              branch: targetBranch,
              headSha: headState.headSha,
              reconcileReason: reconcileDecision.reason,
            }),
        stderr: "",
      }
    }

    yield* ensureLocalOmnigraphReady(repoRoot)
    const clusterRepoRoot = existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))
      ? repoRoot
      : findWorkspaceRoot(repoRoot)

    const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
      repoRoot: clusterRepoRoot,
      branch: targetBranch,
      from: taskBranches.mainBranch,
      snapshotPath,
    }).pipe(
      Effect.provide(OmnigraphSync.Live),
      Effect.orElseSucceed(() => ({
        syncedToOmnigraph: false,
        snapshotPath,
        error: undefined,
      })),
    )
    writeGraphHeadMeta(repoRoot, headState)
    return {
      exitCode: 0,
      stdout: isAntigravity
        ? JSON.stringify({})
        : JSON.stringify({
            indexedFns: fnIndex.bySpanName.size,
            syncedToOmnigraph: syncRes.syncedToOmnigraph,
            branch: targetBranch,
            headSha: headState.headSha,
            reconcileReason: reconcileDecision.reason,
          }),
      stderr: "",
    }
  }

  return {
    exitCode: 0,
    stdout: isAntigravity
      ? JSON.stringify({})
      : JSON.stringify({
          indexedFns: fnIndex.bySpanName.size,
          syncedToOmnigraph: true,
          branch: reconcileDecision.targetOmnigraphBranch,
          headSha: headState.headSha,
          reconcileReason: reconcileDecision.reason,
        }),
    stderr: "",
  }
})

const handleLearn = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldClear = argv.includes("--clear")
    const events = readFrictionEvents(repoRoot)
    const clusters = summarizeFrictionEvents(events)
    const proposals = []
    let useFastFallback =
      (shouldClear && options?.decisionLayer === undefined) || argv.includes("--deterministic")

    for (const cluster of clusters) {
      const input = {
        kind: cluster.kind,
        summary: cluster.summary,
        detail: cluster.detail,
        occurrences: cluster.occurrences,
      }
      const proposal = useFastFallback
        ? deterministicLearnFallback(input)
        : yield* proposeLearningAction(input).pipe(Effect.provide(decisionLayer))
      if (proposal.source === "deterministic-fallback") {
        useFastFallback = true
      }
      proposals.push({
        key: cluster.key,
        kind: cluster.kind,
        summary: cluster.summary,
        occurrences: cluster.occurrences,
        lastSeen: cluster.lastSeen,
        ...proposal,
      })
    }

    let synthesizedRules: ReadonlyArray<unknown> = []
    const rejectedRules: Array<{ ruleId: string; stage: string; reason: string }> = []
    let planSearchResults: unknown = undefined
    const learnedSlicesPath = join(repoRoot, ".harness", "learned-slices.json")
    if (existsSync(learnedSlicesPath)) {
      const rawSlices = yield* Effect.try({
        try: () => readFileSync(learnedSlicesPath, "utf-8"),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (rawSlices !== undefined) {
        const decodeJson = Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )
        const parsedOpt = decodeJson(rawSlices)
        yield* match(parsedOpt)
          .with({ _tag: "Some" }, ({ value: parsed }) =>
            Effect.gen(function* () {
              if (Array.isArray(parsed["slices"])) {
                const rules: Array<unknown> = []
                for (const s of parsed["slices"]) {
                  const decodedSlice = Schema.decodeUnknownOption(RuleSynthesizerInput)(s)
                  yield* match(decodedSlice)
                    .with({ _tag: "Some" }, ({ value: slice }) =>
                      Effect.gen(function* () {
                        const synthRes = yield* decideRuleSynthesizer(slice).pipe(
                          Effect.map((report) => ({ _tag: "Ok" as const, report })),
                          Effect.catchTag("RuleSynthesisError", (err) =>
                            Effect.succeed({ _tag: "Err" as const, err }),
                          ),
                        )
                        match(synthRes)
                          .with({ _tag: "Ok" }, ({ report }) => {
                            rules.push(report)
                          })
                          .with({ _tag: "Err" }, ({ err }) => {
                            rejectedRules.push({
                              ruleId: String(slice.taskId),
                              stage: err.stage ?? "unknown",
                              reason: err.reason ?? err.message,
                            })
                          })
                          .exhaustive()
                      }),
                    )
                    .with({ _tag: "None" }, () => Effect.void)
                    .exhaustive()
                }
                synthesizedRules = rules
              }
              if (Array.isArray(parsed["candidates"])) {
                const rawPlanInput: unknown = {
                  candidates: parsed["candidates"],
                  requireZeroViolations: false,
                }
                const decodedPlanSearch = Schema.decodeUnknownOption(PlanSearchInput)(rawPlanInput)
                planSearchResults = yield* match(decodedPlanSearch)
                  .with({ _tag: "Some" }, ({ value: input }) =>
                    decidePlanSearch(input).pipe(Effect.orElseSucceed(() => undefined)),
                  )
                  .with({ _tag: "None" }, () => Effect.void)
                  .exhaustive()
              }
            }),
          )
          .with({ _tag: "None" }, () => Effect.void)
          .exhaustive()
      }
    }

    if (shouldClear) {
      clearFrictionEvents(repoRoot)
    }

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        totalEvents: events.length,
        proposals,
        cleared: shouldClear,
        ...(synthesizedRules.length > 0 ? { synthesizedRules } : {}),
        ...(rejectedRules.length > 0 ? { rejectedRules } : {}),
        ...(planSearchResults !== undefined ? { planSearchResults } : {}),
      }),
      stderr: "",
    }
  })

const handleOntology = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const graph = options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot))
    const sub = argv[1] ?? "layers"

    return yield* match(sub)
      .with("why", () => {
        const symbol = argv[2] ?? ""
        return Effect.succeed({
          exitCode: 0,
          stdout: JSON.stringify(queryOntologyWhy(graph, symbol)),
          stderr: "",
        })
      })
      .with("impact", () => {
        const symbol = argv[2] ?? ""
        return Effect.succeed({
          exitCode: 0,
          stdout: JSON.stringify(queryOntologyImpact(graph, symbol)),
          stderr: "",
        })
      })
      .with("layers", () => {
        const formatMermaid = argv.includes("--format=mermaid")
        return Effect.succeed({
          exitCode: 0,
          stdout: formatMermaid
            ? renderOntologyMermaid(graph)
            : JSON.stringify(projectOntologyLayers(graph)),
          stderr: "",
        })
      })
      .with("check", () =>
        Effect.gen(function* () {
          const strict = argv.includes("--strict")
          const scopeArg = argv.find((arg) => arg.startsWith("--scope="))
          const scope = scopeArg ? scopeArg.slice("--scope=".length) : undefined

          const allDocs = options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot)
          const docs = scope
            ? allDocs.filter(
                (doc) =>
                  doc.id.startsWith(`${scope}:`) ||
                  doc.docPath.includes(`libs/${scope}/`) ||
                  doc.docPath.includes(`apps/${scope}/`) ||
                  doc.docPath.includes(`packages/${scope}/`),
              )
            : allDocs

          const invariants = yield* decideOntologyInvariants({
            graph,
            governanceDocs: docs,
          })
          const pairs = extractOntologyConflictPairs(docs, scope)
          const semanticConflicts = yield* evaluateOntologyConflicts(pairs).pipe(
            Effect.provide(decisionLayer),
          )
          const clean = invariants.clean && semanticConflicts.length === 0

          return {
            exitCode: strict && !clean ? 1 : 0,
            stdout: JSON.stringify({
              clean,
              findings: invariants.findings,
              semanticConflicts,
              evaluatedPairs: pairs.length,
            }),
            stderr: "",
          }
        }),
      )
      .otherwise(() =>
        Effect.succeed({
          exitCode: 1,
          stdout: "",
          stderr: `unknown ontology subcommand: ${sub}\nusage: harness ontology <why|impact|layers|check>`,
        }),
      )
  })

const handleReport = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.sync(() => {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    if (argv.includes("--reset") || argv.includes("--clear")) {
      clearTelemetryEvents(repoRoot)
    }
    const events = readTelemetryEvents(repoRoot)
    const frictionEvents = readFrictionEvents(repoRoot)
    const stampCheck = checkVerifyStamp(repoRoot)
    const report = buildSessionReport({
      events,
      frictionEvents,
      stampValid: stampCheck.valid,
      cumulative: argv.includes("--all"),
    })
    if (options?.repoRoot !== undefined || process.env.VITEST === undefined) {
      writeSessionReportFiles(repoRoot, report)
    }
    if (argv.includes("--format=markdown")) {
      return {
        exitCode: 0,
        stdout: renderSessionReportMarkdown(report),
        stderr: "",
      }
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(report),
      stderr: "",
    }
  })

const formatProjectionError = (err: unknown): string => {
  if (typeof err === "object" && err !== null) {
    const rec = err as Record<string, unknown>
    const tag = typeof rec._tag === "string" ? rec._tag : undefined
    const reason = typeof rec.reason === "string" ? rec.reason : undefined
    const msg = typeof rec.message === "string" ? rec.message : undefined
    if (tag !== undefined && reason !== undefined) {
      return msg !== undefined ? `${tag} (${reason}): ${msg}` : `${tag} (${reason})`
    }
    if (msg !== undefined) {
      return msg
    }
  }
  return String(err)
}

const matchesExactSpecToken = (text: string, specId: string): boolean => {
  const escaped = specId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const tokenRegex = new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`)
  return tokenRegex.test(text)
}

const persistVerifiedOverlays = (
  repoRoot: string,
  overlays: ReadonlyArray<ShadowFileOverlay>,
): Effect.Effect<
  {
    readonly ok: boolean
    readonly writtenFiles: ReadonlyArray<string>
    readonly rejectedFiles: ReadonlyArray<{ readonly file: string; readonly reason: string }>
    readonly error?: string | undefined
  },
  never,
  never
> =>
  Effect.gen(function* () {
    const canonicalRoot = resolve(repoRoot)
    const rejectedFiles: Array<{ readonly file: string; readonly reason: string }> = []
    for (const overlay of overlays) {
      const absTarget = resolve(canonicalRoot, overlay.targetFile)
      if (!absTarget.startsWith(`${canonicalRoot}/`) || absTarget === canonicalRoot) {
        rejectedFiles.push({
          file: overlay.targetFile,
          reason: "Target path escapes workspace root.",
        })
        continue
      }
      const guardDecision = classifyFileWrite(overlay.targetFile)
      if (guardDecision.verdict !== "allow") {
        rejectedFiles.push({
          file: overlay.targetFile,
          reason: `File write verdict is '${guardDecision.verdict}': ${guardDecision.reason}`,
        })
      }
    }

    if (rejectedFiles.length > 0) {
      return {
        ok: false,
        writtenFiles: [],
        rejectedFiles,
        error: `Refusing to write ${rejectedFiles.length} protected or out-of-workspace file(s): ${rejectedFiles.map((r) => `${r.file} (${r.reason})`).join("; ")}`,
      }
    }

    const writtenFiles: Array<string> = []
    const writeExit = yield* Effect.exit(
      Effect.try({
        try: () => {
          for (const overlay of overlays) {
            const absTarget = resolve(canonicalRoot, overlay.targetFile)
            mkdirSync(dirname(absTarget), { recursive: true })
            writeFileSync(absTarget, overlay.content, "utf-8")
            writtenFiles.push(overlay.targetFile)
          }
        },
        catch: (fsErr) => (fsErr instanceof Error ? fsErr.message : String(fsErr)),
      }),
    )

    return match(writeExit)
      .with({ _tag: "Success" }, () => ({
        ok: true,
        writtenFiles,
        rejectedFiles: [],
      }))
      .with({ _tag: "Failure" }, (f) => ({
        ok: false,
        writtenFiles,
        rejectedFiles: [],
        error: `Filesystem write failed: ${String(f.cause)}`,
      }))
      .exhaustive()
  })

const handlePlanSynth = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldWrite = argv.includes("--write")
    const verifyRoundTrip = shouldWrite || argv.includes("--verify")
    const specId = argv.slice(1).find((arg) => !arg.startsWith("--"))

    if (specId === undefined || specId.trim().length === 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "usage: harness plan-synth <spec-id> [--write] [--verify]",
      }
    }

    const graph = options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot))
    const rewriteOutcome = yield* decideGraphRewrite(graph, "auto-plan")
    const candidates = [
      ...Option.toArray(rewriteOutcome.result.recommendedCandidate),
      ...rewriteOutcome.result.alternativeCandidates,
    ]
    const selected =
      Option.getOrUndefined(rewriteOutcome.result.recommendedCandidate) ??
      candidates[0]
    const filteredPatches =
      selected !== undefined
        ? selected.patches.filter(
            (p) =>
              matchesExactSpecToken(p.description, specId) ||
              p.insertedEntityNodes.some((n) => matchesExactSpecToken(getNodeKey(n), specId)) ||
              p.insertedRoleEdges.some(
                (e) =>
                  matchesExactSpecToken(e.entityKey, specId) ||
                  matchesExactSpecToken(e.relationId, specId),
              ),
          )
        : []

    if (filteredPatches.length === 0) {
      const msg = `No plan-synth patches matched specification '${specId}'.`
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          specId,
          mode: "auto-plan",
          error: msg,
          patchCount: 0,
          operationCount: 0,
          overlayCount: 0,
          overlays: [],
          operations: [],
          verificationStatus: VerificationStatus.make("Unverified"),
          roundTripVerified: false,
          compilerDiagnostics: [],
          bisectionProbes: BisectionProbeCount.make(0),
          skippedRuleIds: [],
          written: false,
          writtenFiles: [],
        }),
        stderr: msg,
      }
    }

    const projection = yield* decideGraphProjection({
      patches: filteredPatches,
      targetGraph: rewriteOutcome.targetGraph,
      workspaceRoot: repoRoot,
      initialGraph: graph,
      verifyRoundTrip,
    })

    if (projection.skippedRuleIds.length > 0) {
      const skipMsg = `Skipped ${projection.skippedRuleIds.length} patch(es) due to round-trip verification failure: ${projection.skippedRuleIds.join(", ")}`
      if (shouldWrite) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            specId,
            mode: "auto-plan",
            error: "Round-trip verification failed; aborting file write.",
            verificationStatus: projection.verificationStatus,
            roundTripVerified: false,
            compilerDiagnostics: projection.compilerDiagnostics,
            skippedRuleIds: projection.skippedRuleIds,
            written: false,
            writtenFiles: [],
          }),
          stderr: skipMsg,
        }
      }
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          specId,
          mode: "auto-plan",
          totalStepsApplied: selected?.patches.length ?? 0,
          patchCount: filteredPatches.length,
          operationCount: projection.operations.length,
          overlayCount: projection.overlays.length,
          overlays: projection.overlays,
          operations: projection.operations,
          verificationStatus: projection.verificationStatus,
          roundTripVerified: projection.roundTripVerified,
          compilerDiagnostics: projection.compilerDiagnostics,
          bisectionProbes: projection.bisectionProbes,
          skippedRuleIds: projection.skippedRuleIds,
          written: false,
          writtenFiles: [],
        }),
        stderr: skipMsg,
      }
    }

    if (shouldWrite && projection.verificationStatus !== "Verified") {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          specId,
          mode: "auto-plan",
          error: "Round-trip verification failed; aborting file write.",
          verificationStatus: projection.verificationStatus,
          roundTripVerified: false,
          compilerDiagnostics: projection.compilerDiagnostics,
          skippedRuleIds: projection.skippedRuleIds,
          written: false,
          writtenFiles: [],
        }),
        stderr: "Round-trip verification failed; aborting file write.",
      }
    }

    let writtenFiles: ReadonlyArray<string> = []
    if (shouldWrite) {
      if (projection.overlays.length === 0) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            specId,
            mode: "auto-plan",
            error: "No projected overlays to write.",
            written: false,
            writtenFiles: [],
          }),
          stderr: "No projected overlays to write.",
        }
      }
      const writeResult = yield* persistVerifiedOverlays(repoRoot, projection.overlays)
      if (!writeResult.ok) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            specId,
            mode: "auto-plan",
            error: writeResult.error,
            rejectedFiles: writeResult.rejectedFiles,
            written: false,
            writtenFiles: writeResult.writtenFiles,
          }),
          stderr: writeResult.error ?? "Failed to write overlays.",
        }
      }
      writtenFiles = writeResult.writtenFiles
    }

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        specId,
        mode: "auto-plan",
        totalStepsApplied: selected?.patches.length ?? 0,
        patchCount: filteredPatches.length,
        operationCount: projection.operations.length,
        overlayCount: projection.overlays.length,
        overlays: projection.overlays,
        operations: projection.operations,
        verificationStatus: projection.verificationStatus,
        roundTripVerified: projection.roundTripVerified,
        compilerDiagnostics: projection.compilerDiagnostics,
        bisectionProbes: projection.bisectionProbes,
        skippedRuleIds: projection.skippedRuleIds,
        written: shouldWrite,
        writtenFiles,
      }),
      stderr: "",
    }
  }).pipe(
    Effect.catch((err: unknown) =>
      Effect.succeed<CliResult>({
        exitCode: 1,
        stdout: "",
        stderr: formatProjectionError(err),
      }),
    ),
  )

const handleRepair = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldWrite = argv.includes("--write")
    const verifyRoundTrip = shouldWrite || argv.includes("--verify")
    let ruleFilter: string | undefined = undefined
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!
      const nextArg = argv[i + 1]
      const parsed = match(arg)
        .with(P.string.startsWith("--rule="), (a) => ({
          filter: a.slice("--rule=".length),
          advance: 0,
        }))
        .with("--rule", () =>
          nextArg !== undefined
            ? { filter: nextArg, advance: 1 }
            : { filter: undefined, advance: 0 },
        )
        .otherwise(() => ({ filter: undefined, advance: 0 }))
      if (parsed.filter !== undefined) {
        ruleFilter = parsed.filter
        i += parsed.advance
      }
    }

    const graph = options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot))
    const rewriteOutcome = yield* decideGraphRewrite(graph, "auto-repair")
    const candidates = [
      ...Option.toArray(rewriteOutcome.result.recommendedCandidate),
      ...rewriteOutcome.result.alternativeCandidates,
    ]
    const selected =
      Option.getOrUndefined(rewriteOutcome.result.recommendedCandidate) ??
      candidates[0]
    const filteredPatches =
      selected !== undefined
        ? ruleFilter !== undefined && ruleFilter.length > 0
          ? selected.patches.filter((p) => p.ruleId === ruleFilter)
          : selected.patches
        : []

    if (ruleFilter !== undefined && ruleFilter.length > 0 && filteredPatches.length === 0) {
      const msg = `No repair patches matched rule filter '${ruleFilter}'.`
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          mode: "auto-repair",
          ruleFilter,
          error: msg,
          patchCount: 0,
          operationCount: 0,
          overlayCount: 0,
          overlays: [],
          operations: [],
          verificationStatus: VerificationStatus.make("Unverified"),
          roundTripVerified: false,
          compilerDiagnostics: [],
          bisectionProbes: BisectionProbeCount.make(0),
          skippedRuleIds: [],
          written: false,
          writtenFiles: [],
        }),
        stderr: msg,
      }
    }

    const projection =
      selected !== undefined && filteredPatches.length > 0
        ? yield* decideGraphProjection({
            patches: filteredPatches,
            targetGraph: rewriteOutcome.targetGraph,
            workspaceRoot: repoRoot,
            initialGraph: graph,
            verifyRoundTrip,
          })
        : {
            operations: [],
            overlays: [],
            verificationStatus: VerificationStatus.make("Unverified"),
            roundTripVerified: false,
            compilerDiagnostics: [],
            bisectionProbes: BisectionProbeCount.make(0),
            skippedRuleIds: [],
          }

    if (projection.skippedRuleIds.length > 0) {
      const skipMsg = `Skipped ${projection.skippedRuleIds.length} patch(es) due to round-trip verification failure: ${projection.skippedRuleIds.join(", ")}`
      if (shouldWrite) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            mode: "auto-repair",
            ruleFilter: ruleFilter ?? null,
            error: "Round-trip verification failed; aborting file write.",
            verificationStatus: projection.verificationStatus,
            roundTripVerified: false,
            compilerDiagnostics: projection.compilerDiagnostics,
            skippedRuleIds: projection.skippedRuleIds,
            written: false,
            writtenFiles: [],
          }),
          stderr: skipMsg,
        }
      }
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          mode: "auto-repair",
          ruleFilter: ruleFilter ?? null,
          totalStepsApplied: selected?.patches.length ?? 0,
          patchCount: filteredPatches.length,
          operationCount: projection.operations.length,
          overlayCount: projection.overlays.length,
          overlays: projection.overlays,
          operations: projection.operations,
          verificationStatus: projection.verificationStatus,
          roundTripVerified: projection.roundTripVerified,
          compilerDiagnostics: projection.compilerDiagnostics,
          bisectionProbes: projection.bisectionProbes,
          skippedRuleIds: projection.skippedRuleIds,
          written: false,
          writtenFiles: [],
        }),
        stderr: skipMsg,
      }
    }

    if (shouldWrite && projection.verificationStatus !== "Verified") {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          mode: "auto-repair",
          ruleFilter: ruleFilter ?? null,
          error: "Round-trip verification failed; aborting file write.",
          verificationStatus: projection.verificationStatus,
          roundTripVerified: false,
          compilerDiagnostics: projection.compilerDiagnostics,
          skippedRuleIds: projection.skippedRuleIds,
          written: false,
          writtenFiles: [],
        }),
        stderr: "Round-trip verification failed; aborting file write.",
      }
    }

    let writtenFiles: ReadonlyArray<string> = []
    if (shouldWrite) {
      if (projection.overlays.length === 0) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            mode: "auto-repair",
            ruleFilter: ruleFilter ?? null,
            error: "No projected overlays to write.",
            written: false,
            writtenFiles: [],
          }),
          stderr: "No projected overlays to write.",
        }
      }
      const writeResult = yield* persistVerifiedOverlays(repoRoot, projection.overlays)
      if (!writeResult.ok) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            mode: "auto-repair",
            ruleFilter: ruleFilter ?? null,
            error: writeResult.error,
            rejectedFiles: writeResult.rejectedFiles,
            written: false,
            writtenFiles: writeResult.writtenFiles,
          }),
          stderr: writeResult.error ?? "Failed to write overlays.",
        }
      }
      writtenFiles = writeResult.writtenFiles
    }

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        mode: "auto-repair",
        ruleFilter: ruleFilter ?? null,
        totalStepsApplied: selected?.patches.length ?? 0,
        patchCount: filteredPatches.length,
        operationCount: projection.operations.length,
        overlayCount: projection.overlays.length,
        overlays: projection.overlays,
        operations: projection.operations,
        verificationStatus: projection.verificationStatus,
        roundTripVerified: projection.roundTripVerified,
        compilerDiagnostics: projection.compilerDiagnostics,
        bisectionProbes: projection.bisectionProbes,
        skippedRuleIds: projection.skippedRuleIds,
        written: shouldWrite,
        writtenFiles,
      }),
      stderr: "",
    }
  }).pipe(
    Effect.catch((err: unknown) =>
      Effect.succeed<CliResult>({
        exitCode: 1,
        stdout: "",
        stderr: formatProjectionError(err),
      }),
    ),
  )

export const makeLiveCliCommandRegistryLayer = (
  options?: CliEnv,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel> = LocalDecisionModel,
): Layer.Layer<HarnessCommandRegistry> =>
  makeHarnessCommandRegistryLayer([
    {
      name: CliCommandName.make("guard"),
      summary: "Evaluate deterministic command and file-write guard policies.",
      execute: (args) => handleGuard(args, options, decisionLayer),
    },
    {
      name: CliCommandName.make("route"),
      summary: "Route a plan step to canonical agent-patterns/*.md documentation.",
      execute: (args) => handleRoute(args, options, decisionLayer),
    },
    {
      name: CliCommandName.make("plan-check"),
      summary: "Validate compilable stub<A,E,R>() skeletons and snapshot plan/current.",
      execute: (args) => handlePlanCheck(args, options),
    },
    {
      name: CliCommandName.make("plan-synth"),
      summary: "Synthesize plan graph patches via Double-Pushout (DPO) rules.",
      execute: (args) => handlePlanSynth(args, options),
    },
    {
      name: CliCommandName.make("repair"),
      summary: "Repair architectural and code antipatterns via DPO rules.",
      execute: (args) => handleRepair(args, options),
    },
    {
      name: CliCommandName.make("verify"),
      summary: "Execute affected verify targets, check span budgets, and write verify-stamp.json.",
      execute: () => handleVerify(options, decisionLayer),
    },
    {
      name: CliCommandName.make("done"),
      summary: "Verify stamp freshness, diff plan vs impl graph, and merge impl/current to main.",
      execute: (args) => handleDone(args, options, decisionLayer),
    },
    {
      name: CliCommandName.make("learn"),
      summary: "Cluster friction-log.jsonl events and propose deterministic promotions.",
      execute: (args) => handleLearn(args, options, decisionLayer),
    },
    {
      name: CliCommandName.make("gc"),
      summary: "Run zero-entropy graph garbage collection and governance lint.",
      execute: (args) => handleGc(args, options),
    },
    {
      name: CliCommandName.make("mutate"),
      summary: "Run in-process Mutant Schemata and saturation verification over domain code.",
      execute: (args) => handleMutate(args.slice(1), options),
    },
    {
      name: CliCommandName.make("bench"),
      summary: "Measure harness stage latencies and enforce p50/p95 SLO budgets.",
      execute: (args) => handleBench(args.slice(1), options),
    },
    {
      name: CliCommandName.make("ingest"),
      summary: "Ingest runtime trace NDJSON events into Omnigraph.",
      execute: (args) => handleIngest(args, options),
    },
    {
      name: CliCommandName.make("session"),
      summary: "Inspect active session handoff state and inject pending stubs.",
      execute: (args) => handleDoctorOrSession(args, options, decisionLayer),
    },
    {
      name: CliCommandName.make("doctor"),
      summary: "Run workspace health diagnostics and session recovery checks.",
      execute: (args) => handleDoctorOrSession(args, options, decisionLayer),
    },
    {
      name: CliCommandName.make("ontology"),
      summary: "Audit ArchiMate 3.2 cross-layer traceability and semantic conflicts.",
      execute: (args) => handleOntology(args, options, decisionLayer),
    },
    {
      name: CliCommandName.make("report"),
      summary: "Generate session telemetry and friction report.",
      execute: (args) => handleReport(args, options),
    },
    {
      name: CliCommandName.make("help"),
      summary: "Display CLI usage help and available commands.",
      execute: () =>
        Effect.succeed({
          exitCode: 0,
          stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
          stderr: "",
        }),
    },
  ])

registerLiveCliCommandHandlers(
  CANONICAL_CLI_COMMAND_NAMES.reduce<
    Record<string, (args: ReadonlyArray<string>) => Effect.Effect<CliResult>>
  >((acc, name) => {
    acc[name] = (args) => {
      const liveLayer = makeLiveCliCommandRegistryLayer()
      return dispatchCliCommand({ command: name, args }).pipe(
        Effect.provide(liveLayer),
        Effect.catchTag("CliCommandNotFoundError", (e) =>
          Effect.succeed({
            exitCode: 1,
            stdout: "",
            stderr: `unknown command: ${e.command}\nusage: harness <${COMMANDS.join("|")}>`,
          }),
        ),
      )
    }
    return acc
  }, {}),
)

export const runCliEffect = (
  argv: ReadonlyArray<string>,
  options?: CliEnv,
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const requested = argv[0] ?? "help"
    const effectiveOptions =
      maybeDecisionLayer !== undefined ? { ...options, decisionLayer: maybeDecisionLayer } : options
    const decisionLayer = effectiveOptions?.decisionLayer ?? LocalDecisionModel
    const repoRoot = effectiveOptions?.repoRoot ?? findWorkspaceRoot()

    if (effectiveOptions?.repoRoot === undefined && process.env.VITEST === undefined) {
      yield* Effect.try(() => {
        const harnessDir = join(CLI_REPO_ROOT, ".harness")
        mkdirSync(harnessDir, { recursive: true })
        writeFileSync(
          join(harnessDir, "active-workspace.json"),
          JSON.stringify({ repoRoot, updatedAt: new Date().toISOString() }, null, 2),
        )
      }).pipe(Effect.ignore)
    }

    if (!isCommand(requested)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `unknown command: ${requested}\nusage: harness <${COMMANDS.join("|")}>`,
      }
    }

    if (argv.includes("--help") || argv.includes("-h")) {
      return {
        exitCode: 0,
        stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
        stderr: "",
      }
    }

    const liveCommandLayer = makeLiveCliCommandRegistryLayer(effectiveOptions, decisionLayer)
    const startTime = performance.now()
    const res: CliResult = yield* dispatchCliCommand({
      command: requested,
      args: argv,
    }).pipe(
      Effect.provide(liveCommandLayer),
      Effect.catchTag("CliCommandNotFoundError", (e) =>
        Effect.succeed<CliResult>({
          exitCode: 1,
          stdout: "",
          stderr: `unknown command: ${e.command}\nusage: harness <${COMMANDS.join("|")}>`,
        }),
      ),
    )
    const durationMs = Math.max(0, Math.round(performance.now() - startTime))

    const surface: TelemetrySurface =
      argv.includes("--format=antigravity") || effectiveOptions?.stdin !== undefined ? "hook" : "cli"

    let category: TelemetryCategory = "lifecycle"
    if (requested === "guard") {
      category = "guard"
    } else if (requested === "route") {
      category = "routing"
    } else if (requested === "ontology") {
      category = "ontology"
    } else if (
      requested === "plan-check" ||
      requested === "verify" ||
      requested === "gc" ||
      requested === "mutate" ||
      requested === "bench"
    ) {
      category = "gate"
    } else {
      category = "lifecycle"
    }

    let outcome: TelemetryOutcome = "ok"
    if (requested === "guard") {
      if (res.exitCode !== 0 || res.stdout.includes('"decision":"deny"')) {
        outcome = "deny"
      } else if (
        res.stdout.includes('"decision":"ask"') ||
        res.stdout.includes('"permissionDecision":"ask"')
      ) {
        outcome = "ask"
      } else {
        outcome = "ok"
      }
    } else if (requested === "done") {
      if (
        res.stdout.includes('"decision":"continue"') ||
        res.stdout.includes('"decision":"block"')
      ) {
        outcome = "fail"
      } else {
        outcome = "ok"
      }
    } else if (requested === "route") {
      outcome = res.stdout === "review" ? "fallback" : "ok"
    } else {
      outcome = res.exitCode === 0 ? "ok" : "fail"
    }

    recordTelemetry(options, {
      surface,
      category,
      toolName: requested === "ontology" ? `ontology:${argv[1] ?? "layers"}` : requested,
      outcome,
      durationMs,
      ...(res.telemetryDetail !== undefined ? { detail: res.telemetryDetail } : {}),
    })

    if (
      requested === "done" &&
      outcome === "ok" &&
      res.telemetryDetail !== "fullyIdle=false" &&
      res.telemetryDetail !== "subagent=true" &&
      res.telemetryDetail !== "readOnly=true" &&
      (options?.repoRoot !== undefined || process.env.VITEST === undefined)
    ) {
      const finalEvents = readTelemetryEvents(repoRoot)
      const finalFriction = readFrictionEvents(repoRoot)
      const finalReport = buildSessionReport({
        events: finalEvents,
        frictionEvents: finalFriction,
        stampValid: true,
      })
      writeSessionReportFiles(repoRoot, finalReport)
    }

    return res
  })

export const runCli = (
  argv: ReadonlyArray<string>,
  options?: CliEnv,
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Promise<CliResult> => Effect.runPromise(runCliEffect(argv, options, maybeDecisionLayer))

export * from "./commands/command-registry.js"

export const run = (argv: ReadonlyArray<string>): number => {
  const requested = argv[0] ?? "help"
  if (!isCommand(requested)) {
    console.error(`unknown command: ${requested}`)
    console.error(`usage: harness <${COMMANDS.join("|")}>`)
    return 1
  }
  console.log(`harness ${requested}`)
  return 0
}

if (
  process.argv[1] !== undefined &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith("index.ts"))
) {
  void Effect.runPromise(runCliEffect(process.argv.slice(2)))
    .then((res) => {
      if (res.stdout) {
        process.stdout.write(res.stdout.endsWith("\n") ? res.stdout : res.stdout + "\n")
      }
      if (res.stderr) {
        process.stderr.write(res.stderr.endsWith("\n") ? res.stderr : res.stderr + "\n")
      }
      process.exit(res.exitCode)
    })
    .catch((err: unknown) => {
      console.error(String(err))
      process.exit(1)
    })
}
