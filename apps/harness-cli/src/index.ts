import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Option, Schema } from "effect"
import * as Graph from "effect/Graph"
import * as DecisionModel from "effect/ai/DecisionModel"
import {
  checkPlanStepCoverage,
  decideGuardCommand,
  evaluateOntologyConflicts,
  extractOntologyConflictPairs,
  IDIOM_BLOCKS,
  IdiomRouterV1,
  LocalDecisionModel,
  proposeLearningAction,
  routeStep,
  triageFailure
} from "@harness/decision"
import {
  appendFrictionEvent,
  appendTelemetryEvent,
  buildSessionHandoff,
  buildSessionReport,
  checkLoopThrashing,
  checkVerifyStamp,
  classifyCommand,
  classifyFileWrite,
  clearFrictionEvents,
  clearTelemetryEvents,
  decideOntologyInvariants,
  deriveRepoOmnigraphPort,
  diffPlanAndImplGraphs,
  type FrictionEventKind,
  type GovernanceDocReference,
  loadGovernanceDocsFromDisk,
  readFrictionEvents,
  readTelemetryEvents,
  renderSessionReportMarkdown,
  resolveCanonicalRepoRoot,
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
  writeSessionReportFiles,
  writeVerifyStamp
} from "@harness/gates"
import {
  checkEffectGraph,
  diffOmnigraphBranches,
  extractWorkspaceTypeAwareGraph,
  type HarnessGraph,
  loadGraphSnapshot,
  mergeOmnigraphBranch,
  OmnigraphSync,
  projectOntologyLayers,
  queryOntologyImpact,
  queryOntologyWhy,
  renderOntologyMermaid,
  syncToOmnigraphAndSnapshot
} from "@harness/graph"
import { buildWorkspaceFnIndex } from "@harness/ingest"

export const COMMANDS = [
  "guard",
  "route",
  "plan-check",
  "verify",
  "done",
  "learn",
  "gc",
  "mutate",
  "ingest",
  "session",
  "doctor",
  "ontology",
  "report",
  "help"
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
  readonly planSteps?: ReadonlyArray<{
    readonly stepId: string
    readonly planStep: string
    readonly stepDiff: string
  }> | undefined
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
      path: Schema.optional(Schema.String)
    })
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
          file_path: Schema.optional(Schema.String)
        })
      )
    })
  )
})

const decodePreToolUseStdin = Schema.decodeOption(
  Schema.fromJsonString(PreToolUseStdinSchema)
)

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

const formatSubprocessError = (err: unknown): string => {
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
      return combined
    }
    if (typeof rec.message === "string") {
      return rec.message
    }
  }
  return String(err)
}

const handleGuard = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const isAntigravityFlag = argv.includes("--format=antigravity")
    const fileFlag = argv.find((arg) => arg.startsWith("--file="))
    const cliFilePath = fileFlag ? fileFlag.slice("--file=".length) : undefined
    const positionalArgs = argv
      .slice(1)
      .filter((arg) => arg !== "--format=antigravity" && !arg.startsWith("--file="))

    let rawStdin = options?.stdin
    if (positionalArgs.length === 0 && !cliFilePath && rawStdin === undefined && !process.stdin.isTTY) {
      rawStdin = yield* Effect.try({
        try: () => readFileSync(0, "utf8"),
        catch: () => ""
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
            decoded.value.toolCall.args?.CommandLine ??
            decoded.value.toolCall.args?.command
          stdinFilePath =
            decoded.value.toolCall.args?.TargetFile ??
            decoded.value.toolCall.args?.AbsolutePath ??
            decoded.value.toolCall.args?.file_path
        } else {
          stdinCmd = decoded.value.tool_input?.command
          stdinFilePath =
            decoded.value.tool_input?.file_path ??
            decoded.value.tool_input?.path
        }
      }
    }
    const isAntigravity = isAntigravityFlag || isAntigravityStdin
    const filePath = cliFilePath ?? stdinFilePath
    const command = positionalArgs.length > 0 ? positionalArgs.join(" ") : stdinCmd ?? ""

    if (filePath && command.trim() === "") {
      const fileGuard = classifyFileWrite(filePath)
      if (fileGuard.verdict === "deny") {
        if (isAntigravity) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: "deny",
              reason: fileGuard.reason
            }),
            stderr: ""
          }
        }
        return {
          exitCode: 2,
          stdout: "",
          stderr: fileGuard.reason ?? `Blocked file write: ${filePath}`
        }
      }
      if (fileGuard.verdict === "ask") {
        if (isAntigravity) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: "ask",
              reason: fileGuard.reason
            }),
            stderr: ""
          }
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "ask",
              permissionDecisionReason: fileGuard.reason
            }
          }),
          stderr: ""
        }
      }
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: ""
      }
    }

    if (command.trim() === "") {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: ""
      }
    }

    const classification = classifyCommand(command)
    if (classification === "deny") {
      if (isAntigravity) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "deny",
            reason: `Blocked by harness guard: ${command}`
          }),
          stderr: ""
        }
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Blocked by harness guard: ${command}`
      }
    }
    if (classification === "allow") {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: ""
      }
    }
    if (classification === "ask") {
      if (isAntigravity) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "ask",
            reason: `Command requires human confirmation: ${command}`
          }),
          stderr: ""
        }
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: `Command requires human confirmation: ${command}`
          }
        }),
        stderr: ""
      }
    }

    // Classification is "escalate" -> consult decision layer
    const decision = yield* decideGuardCommand(command).pipe(
      Effect.provide(decisionLayer)
    )
    recordFriction(options, {
      kind: "guard_escalation",
      summary: command,
      detail: `verdict=${decision.verdict}; reason=${decision.reason}`
    })

    if (decision.verdict === "deny") {
      if (isAntigravity) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: "deny",
            reason: `Blocked by harness guard: ${command}`
          }),
          stderr: ""
        }
      }
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Blocked by harness guard: ${command}`
      }
    }
    if (decision.verdict === "allow") {
      return {
        exitCode: 0,
        stdout: isAntigravity ? JSON.stringify({ decision: "allow" }) : "",
        stderr: ""
      }
    }
    if (isAntigravity) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: "ask",
          reason: decision.reason
        }),
        stderr: ""
      }
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: decision.reason
        }
      }),
      stderr: ""
    }
  })

const recordFriction = (
  options: CliEnv | undefined,
  event: {
    readonly kind: FrictionEventKind
    readonly summary: string
    readonly detail: string
  }
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
  }
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
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const step = argv.slice(1).join(" ")
    const block = yield* routeStep(step).pipe(Effect.provide(decisionLayer))
    if (block === "review") {
      recordFriction(options, {
        kind: "route_miss",
        summary: step,
        detail: "IdiomRouterV1 returned review (no matching agent-patterns/*.md with >= 0.7 confidence)"
      })
    }
    const stdout =
      block === "review" || block === "effect"
        ? block
        : `agent-patterns/${block}.md`
    return { exitCode: 0, stdout, stderr: "" }
  })

const resolveNxAffectedArgs = (
  repoRoot: string,
  targets: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const hasMain = Effect.runSync(
    Effect.try({
      try: () => {
        execFileSync("git", ["rev-parse", "--verify", "main"], {
          cwd: repoRoot,
          stdio: "pipe"
        })
        return true
      },
      catch: () => false
    }).pipe(Effect.orElseSucceed(() => false))
  )
  if (hasMain) {
    return ["nx", "affected", "--base=main", "-t", ...targets]
  }
  const hasHeadParent = Effect.runSync(
    Effect.try({
      try: () => {
        execFileSync("git", ["rev-parse", "--verify", "HEAD~1"], {
          cwd: repoRoot,
          stdio: "pipe"
        })
        return true
      },
      catch: () => false
    }).pipe(Effect.orElseSucceed(() => false))
  )
  if (hasHeadParent) {
    return ["nx", "affected", "--base=HEAD~1", "-t", ...targets]
  }
  return ["nx", "run-many", "-t", ...targets]
}

const handlePlanCheck = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const governanceDocs =
      options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot)
    const graphOnly = argv.includes("--graph-only")

    if (!graphOnly && !options?.skipSubprocessVerify && existsSync(join(repoRoot, "package.json"))) {
      const nxArgs = resolveNxAffectedArgs(repoRoot, ["typecheck", "lint"])
      const subprocessErr = yield* Effect.try({
        try: () => {
          execFileSync("pnpm", nxArgs, {
            cwd: repoRoot,
            stdio: "pipe",
            env: { ...process.env, HARNESS_PLAN_CHECK: "1", CI: "true" }
          })
          return null
        },
        catch: (cause) => formatSubprocessError(cause)
      }).pipe(Effect.catch((msg) => Effect.succeed(msg || "Plan check subprocess failed")))

      if (subprocessErr !== null) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: subprocessErr
        }
      }
    }

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
    if (fnIndex.duplicates.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Duplicate span names found: ${fnIndex.duplicates.join(", ")}`
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
        stderr: formattedViolations
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
      for (const [, edge] of Graph.edges(graph.graph)) {
        if (edge.data._tag === "FailsWith") {
          failsWithErrorTags.add(edge.data.errorTag)
        }
      }
      const violations: Array<string> = []
      for (const doc of governanceDocs) {
        if (doc.status === "accepted" || doc.status === "proposed") {
          for (const errName of doc.referencedErrors ?? []) {
            if (!failsWithErrorTags.has(errName)) {
              violations.push(
                `[dead-tagged-error] Governance doc '${doc.id}' declares TaggedError '${errName}', which has 0 FailsWith edges in the plan graph`
              )
            }
          }
        }
      }
      if (violations.length > 0) {
        return {
          exitCode: 1,
          stdout: JSON.stringify(
            { step: "type-graph-policy", valid: false, violations },
            null,
            2
          ),
          stderr: ""
        }
      }
    }

    if (!graphOnly) {
      yield* ensureLocalOmnigraphReady(repoRoot)
      const clusterRepoRoot = existsSync(
        join(repoRoot, "libs", "harness", "graph", "cluster.yaml")
      )
        ? repoRoot
        : findWorkspaceRoot(repoRoot)
      const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
      const snapshotPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
      const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
        repoRoot: clusterRepoRoot,
        branch: taskBranches.planBranch,
        from: taskBranches.mainBranch,
        snapshotPath
      }).pipe(
        Effect.provide(OmnigraphSync.Live),
        Effect.orElseSucceed(() => ({ syncedToOmnigraph: false, snapshotPath, error: undefined }))
      )
      recordTelemetry(options, {
        surface: "cli",
        category: "graph_query",
        toolName: "omnigraph:sync-plan",
        outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
        durationMs: 1,
        engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "memory-fallback"
      })
      if (!syncRes.syncedToOmnigraph) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Plan check failed: could not sync plan graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`
        }
      }
    }

    return { exitCode: 0, stdout: checkResult.mermaid, stderr: "" }
  })

const handleVerify = (
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)

    const stubs = Array.from(fnIndex.bySpanName.values()).filter((fn) => fn.isStub)
    if (stubs.length > 0) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: active stub() found in ${stubs.map((s) => s.spanName).join(", ")}`
      }
    }

    const graph = yield* extractWorkspaceTypeAwareGraph(repoRoot)
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
        stderr: `Verification failed: active stub() found in ${Array.from(new Set(graphStubs)).join(", ")}`
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
        detail: msg
      })
      const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot))
      if (thrashing.stuck && thrashing.escalationMessage !== null) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `${thrashing.escalationMessage}\n${msg}`
        }
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: msg
      }
    }

    const governanceDocs =
      options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot)
    const ontologyInvariants = yield* decideOntologyInvariants({
      graph,
      governanceDocs
    })
    if (!ontologyInvariants.clean) {
      const msg = ontologyInvariants.findings
        .map((f) => `[${f.kind}] ${f.nodeId}: ${f.message}`)
        .join("\n")
      recordFriction(options, {
        kind: "verify_failure",
        summary: ontologyInvariants.findings[0]?.kind ?? "ontology-invariants-failed",
        detail: msg
      })
      const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot))
      if (thrashing.stuck && thrashing.escalationMessage !== null) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `${thrashing.escalationMessage}\n${msg}`
        }
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: ontology invariants broken\n${msg}`
      }
    }

    yield* ensureLocalOmnigraphReady(repoRoot)
    const clusterRepoRoot = existsSync(
      join(repoRoot, "libs", "harness", "graph", "cluster.yaml")
    )
      ? repoRoot
      : findWorkspaceRoot(repoRoot)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
    const snapshotPath = join(repoRoot, ".harness", "graph-snapshot.json")

    const syncRes = yield* syncToOmnigraphAndSnapshot(graph, {
      repoRoot: clusterRepoRoot,
      branch: taskBranches.implBranch,
      from: taskBranches.mainBranch,
      snapshotPath
    }).pipe(
      Effect.provide(OmnigraphSync.Live),
      Effect.orElseSucceed(() => ({ syncedToOmnigraph: false, snapshotPath, error: undefined }))
    )
    recordTelemetry(options, {
      surface: "cli",
      category: "graph_query",
      toolName: "omnigraph:sync-impl",
      outcome: syncRes.syncedToOmnigraph ? "ok" : "fail",
      durationMs: 1,
      engineSource: syncRes.syncedToOmnigraph ? "omnigraph" : "memory-fallback"
    })
    if (!syncRes.syncedToOmnigraph) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Verification failed: could not sync implementation graph to Omnigraph${syncRes.error ? ` (${syncRes.error})` : ""}`
      }
    }

    if (!options?.skipSubprocessVerify && existsSync(join(repoRoot, "package.json"))) {
      const nxArgs = resolveNxAffectedArgs(repoRoot, ["verify"])
      const subprocessErr = yield* Effect.try({
        try: () => {
          execFileSync("pnpm", nxArgs, {
            cwd: repoRoot,
            stdio: "pipe",
            env: { ...process.env, CI: "true" }
          })
          return null
        },
        catch: (cause) => formatSubprocessError(cause)
      }).pipe(Effect.catch((msg) => Effect.succeed(msg || "Verification subprocess failed")))

      if (subprocessErr !== null) {
        const triage = yield* triageFailure(subprocessErr).pipe(
          Effect.provide(decisionLayer)
        )
        const formattedErr = `[triage:${triage.kind}] ${triage.hint}\n${subprocessErr}`
        recordFriction(options, {
          kind: "verify_failure",
          summary: `verify:${triage.kind}`,
          detail: formattedErr
        })
        const thrashing = checkLoopThrashing(readFrictionEvents(repoRoot))
        if (thrashing.stuck && thrashing.escalationMessage !== null) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: `${thrashing.escalationMessage}\n${formattedErr}`
          }
        }
        return {
          exitCode: 1,
          stdout: "",
          stderr: formattedErr
        }
      }
    }

    const stamp = writeVerifyStamp(repoRoot, taskBranches.implBranch)
    return { exitCode: 0, stdout: JSON.stringify(stamp), stderr: "" }
  })

const StopHookStdinSchema = Schema.Struct({
  fullyIdle: Schema.optional(Schema.Boolean)
})

const decodeStopHookStdin = Schema.decodeOption(
  Schema.fromJsonString(StopHookStdinSchema)
)

const handleDone = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const isAntigravity = argv.includes("--format=antigravity")
    const blockDecision = isAntigravity ? "continue" : "block"

    let rawStdin = options?.stdin
    if (rawStdin === undefined && !process.stdin.isTTY) {
      rawStdin = yield* Effect.try({
        try: () => readFileSync(0, "utf8"),
        catch: () => ""
      }).pipe(Effect.orElseSucceed(() => ""))
    }
    if (rawStdin) {
      const decoded = decodeStopHookStdin(rawStdin)
      if (Option.isSome(decoded) && decoded.value.fullyIdle === false) {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          telemetryDetail: "fullyIdle=false"
        }
      }
    }

    // 1. Stamp check
    const stampCheck = checkVerifyStamp(repoRoot)
    if (!stampCheck.valid) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: blockDecision,
          reason: stampCheck.reason
        }),
        stderr: ""
      }
    }

    // 2. Graph diff check
    let planGraph = options?.planGraph
    let implGraph = options?.implGraph
    if (!planGraph && !implGraph) {
      const planPath = join(repoRoot, ".harness", "plan-graph-snapshot.json")
      const implPath = join(repoRoot, ".harness", "graph-snapshot.json")
      if (existsSync(planPath) && existsSync(implPath)) {
        planGraph = loadGraphSnapshot(planPath)
        implGraph = loadGraphSnapshot(implPath)
      }
    }
    if (planGraph && implGraph) {
      const diff = diffPlanAndImplGraphs(planGraph, implGraph)
      if (!diff.ok) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            decision: blockDecision,
            reason: diff.reasons.join("; ")
          }),
          stderr: ""
        }
      }
    }

    // 3. Plan step coverage check
    if (options?.planSteps && options.planSteps.length > 0) {
      for (const step of options.planSteps) {
        const stepRes = yield* checkPlanStepCoverage(step).pipe(
          Effect.provide(decisionLayer)
        )
        if (!stepRes.covered) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: blockDecision,
              reason: stepRes.reason
            }),
            stderr: ""
          }
        }
      }
    }

    // 4. Diff and merge branch impl into main in Omnigraph (hard gate)
    yield* ensureLocalOmnigraphReady(repoRoot)
    const clusterRepoRoot = existsSync(
      join(repoRoot, "libs", "harness", "graph", "cluster.yaml")
    )
      ? repoRoot
      : findWorkspaceRoot(repoRoot)
    const taskBranches = resolveOmnigraphTaskBranches(repoRoot)
    yield* diffOmnigraphBranches({
      repoRoot: clusterRepoRoot,
      source: taskBranches.implBranch,
      target: taskBranches.planBranch
    }).pipe(
      Effect.provide(OmnigraphSync.Live),
      Effect.orElseSucceed(() => Option.none())
    )

    const merged = yield* mergeOmnigraphBranch({
      repoRoot: clusterRepoRoot,
      source: taskBranches.implBranch,
      target: taskBranches.mainBranch
    }).pipe(
      Effect.provide(OmnigraphSync.Live),
      Effect.orElseSucceed(() => false)
    )
    recordTelemetry(options, {
      surface: isAntigravity ? "hook" : "cli",
      category: "graph_query",
      toolName: "omnigraph:merge-main",
      outcome: merged ? "ok" : "fail",
      durationMs: 1,
      engineSource: merged ? "omnigraph" : "memory-fallback"
    })
    if (!merged) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          decision: blockDecision,
          reason: `Omnigraph branch merge (${taskBranches.implBranch} -> ${taskBranches.mainBranch}) failed`
        }),
        stderr: ""
      }
    }

    // 5. All checks passed
    if (options?.repoRoot !== undefined || process.env.VITEST === undefined) {
      const report = buildSessionReport({
        events: readTelemetryEvents(repoRoot),
        frictionEvents: readFrictionEvents(repoRoot),
        stampValid: true
      })
      writeSessionReportFiles(repoRoot, report)
    }

    return {
      exitCode: 0,
      stdout: isAntigravity ? JSON.stringify({ decision: "stop" }) : "",
      stderr: "",
      telemetryDetail: "completed"
    }
  })

const LockJsonSchema = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown)
)

function unlockOmnigraphClusterIfNeeded(
  omnigraphBin: string,
  clusterRootDir: string,
  applyOutput?: string
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
        catch: () => undefined
      }).pipe(Effect.orElseSucceed(() => undefined))
    )
  }
  for (const lockId of lockIds) {
    Effect.runSync(
      Effect.try({
        try: () => {
          execFileSync(
            omnigraphBin,
            ["cluster", "force-unlock", lockId, "--target", clusterRootDir],
            { stdio: "ignore" }
          )
        },
        catch: () => undefined
      }).pipe(Effect.orElseSucceed(() => undefined))
    )
  }
}

function checkOmnigraphServerReady(baseUrl: string): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: () =>
      globalThis
        .fetch(`${baseUrl}/readyz`, {
          method: "GET",
          signal: AbortSignal.timeout(3000)
        })
        .then((r) => {
          if (
            r.status !== 200 ||
            r.headers.get("Omnigraph-Http-Api") !== "0.14"
          ) {
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
    catch: () => false
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
  clusterRootDir: string
): readonly [string, ReadonlyArray<string>] => [
  "pkill",
  ["-f", `omnigraph-server.*--cluster file://${clusterRootDir}`]
]

const OmnigraphServerMetaSchema = Schema.Struct({
  pid: Schema.optional(Schema.Finite),
  port: Schema.optional(Schema.Finite),
  baseUrl: Schema.optional(Schema.String),
  canonicalRepoRoot: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String)
})

type OmnigraphServerMeta = Schema.Schema.Type<typeof OmnigraphServerMetaSchema>

const decodeOmnigraphServerMeta = Schema.decodeOption(
  Schema.fromJsonString(OmnigraphServerMetaSchema)
)

function ensureLocalOmnigraphReady(
  repoRoot: string
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const clusterRepoRoot = existsSync(
      join(repoRoot, "libs", "harness", "graph", "cluster.yaml")
    )
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
        catch: () => ""
      }).pipe(
        Effect.flatMap((raw) => Effect.fromOption(decodeOmnigraphServerMeta(raw))),
        Effect.option
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
    const currentStamp = existsSync(stampPath)
      ? readFileSync(stampPath, "utf-8")
      : ""
    const configDrifted = currentStamp !== expectedStamp

    if (configDrifted) {
      if (typeof serverMeta?.pid === "number") {
        yield* Effect.try({
          try: () => {
            process.kill(serverMeta.pid!, "SIGTERM")
          },
          catch: () => undefined
        }).pipe(Effect.orElseSucceed(() => undefined))
      }
      yield* Effect.try({
        try: () => {
          const [killBin, killArgs] = buildOmnigraphClusterKillArgs(clusterRootDir)
          execFileSync(killBin, killArgs as string[], { stdio: "ignore" })
        },
        catch: () => undefined
      }).pipe(Effect.orElseSucceed(() => undefined))
      yield* Effect.sleep("300 millis")
      yield* Effect.try({
        try: () => {
          rmSync(clusterRootDir, { recursive: true, force: true })
        },
        catch: () => undefined
      }).pipe(Effect.orElseSucceed(() => undefined))
    } else {
      const isReadyCandidate =
        explicitEnvUrl !== undefined ||
        serverMeta?.canonicalRepoRoot === canonicalRepoRoot
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
              "curl -fsSL https://raw.githubusercontent.com/ModernRelay/omnigraph/main/scripts/install.sh | VERSION=v0.14.0 bash"
            ],
            { stdio: "inherit" }
          )
        },
        catch: () => undefined
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
              "--json"
            ],
            {
              cwd: clusterRepoRoot,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"]
            }
          )
          unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir, out)
          writeFileSync(stampPath, expectedStamp, "utf-8")
        }
        unlockOmnigraphClusterIfNeeded(omnigraphBin, clusterRootDir)

        const bindHostPort =
          targetBaseUrl.match(/^https?:\/\/([^/]+)/)?.[1] ??
          `127.0.0.1:${defaultPort}`

        const child = spawn(
          omnigraphServerBin,
          [
            "--cluster",
            `file://${clusterRootDir}`,
            "--bind",
            bindHostPort,
            "--unauthenticated"
          ],
          {
            cwd: clusterRepoRoot,
            detached: true,
            stdio: "ignore"
          }
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
                updatedAt: new Date().toISOString()
              },
              null,
              2
            ),
            "utf-8"
          )
        }
      },
      catch: () => undefined
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

const handleDoctorOrSession = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
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
      catch: () => false
    }).pipe(Effect.orElseSucceed(() => false))

    const omnigraphInitialized = yield* ensureLocalOmnigraphReady(repoRoot)

    const workspaceRoot = findWorkspaceRoot()
    const tsconfigBasePath = existsSync(join(repoRoot, "tsconfig.base.json"))
      ? join(repoRoot, "tsconfig.base.json")
      : join(workspaceRoot, "tsconfig.base.json")
    const tsgoPkgPath = existsSync(
      join(repoRoot, "node_modules", "@effect", "tsgo", "package.json")
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
      catch: () => false
    }).pipe(Effect.orElseSucceed(() => false))

    const warmUpOpt = yield* DecisionModel.decide(IdiomRouterV1, {
      input: { planStep: "Initialize session" }
    }).pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.catchCause(() => Effect.succeedNone),
      Effect.provide(decisionLayer)
    )
    const modelWarm = Option.isSome(warmUpOpt)

    const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
    const activeStubs = Array.from(fnIndex.bySpanName.values())
      .filter((fn) => fn.isStub)
      .map((fn) => fn.spanName)

    const planPath = join(harnessDir, "plan-graph-snapshot.json")
    const implPath = join(harnessDir, "graph-snapshot.json")
    let missingPlannedFns: ReadonlyArray<string> = []
    if (existsSync(planPath) && existsSync(implPath)) {
      const planGraph = loadGraphSnapshot(planPath)
      const implGraph = loadGraphSnapshot(implPath)
      const diff = diffPlanAndImplGraphs(planGraph, implGraph)
      if (!diff.ok) {
        missingPlannedFns = diff.reasons
      }
    }

    const stampCheck = checkVerifyStamp(repoRoot)
    const hasPlanOrStamp =
      existsSync(planPath) || existsSync(join(harnessDir, "verify-stamp.json"))
    const effectiveStampValid = hasPlanOrStamp ? stampCheck.valid : true
    const stampReason = !stampCheck.valid ? stampCheck.reason : undefined
    const rawFrictionEvents = readFrictionEvents(repoRoot)
    const telemetryEvents = readTelemetryEvents(repoRoot)
    const scoped = scopeSessionReportInput({
      events: telemetryEvents,
      frictionEvents: rawFrictionEvents
    })
    const frictionClusters = summarizeFrictionEvents(scoped.frictionEvents)
    const loopThrashing = checkLoopThrashing(scoped.frictionEvents)

    const handoff = buildSessionHandoff({
      stampValid: effectiveStampValid,
      stampReason,
      activeStubs,
      missingPlannedFns,
      frictionClusters,
      loopThrashing
    })

    const telemetryReport = buildSessionReport({
      events: telemetryEvents,
      frictionEvents: rawFrictionEvents,
      stampValid: effectiveStampValid
    })

    const ok = nodeOk && snapshotDirOk && effectLspOk && omnigraphInitialized

    if (isAntigravity) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          injectSteps: handoff.handoffMessage !== null ? [handoff.handoffMessage] : []
        }),
        stderr: ""
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
        modelWarm,
        handoff,
        telemetry: {
          totalEvents: telemetryReport.totalEvents,
          healthScore: telemetryReport.healthScore,
          grade: telemetryReport.grade
        }
      }),
      stderr: ok
        ? ""
        : `Doctor check failed: nodeOk=${nodeOk}, snapshotDirOk=${snapshotDirOk}, effectLspOk=${effectLspOk}, omnigraphInitialized=${omnigraphInitialized}`
    }
  })

const handleGc = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined
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
      governanceDocs
    })
    const findings = strict
      ? [...report.findings, ...scanWorkspacePackageHygiene(repoRoot)]
      : report.findings
    const finalReport = {
      clean: findings.length === 0,
      findings
    }
    return {
      exitCode: strict && !finalReport.clean ? 1 : 0,
      stdout: JSON.stringify(finalReport),
      stderr: ""
    }
  })

const handleMutate = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    yield* Effect.void
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const strict = argv.includes("--strict")
    const scopeArg = argv.find((arg) => arg.startsWith("--scope="))
    const scope = scopeArg ? scopeArg.slice("--scope=".length) : undefined

    const report = runDomainMutationSuite(repoRoot, { scope })
    return {
      exitCode: strict && !report.passed ? 1 : 0,
      stdout: JSON.stringify(report),
      stderr: ""
    }
  })

const handleLearn = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const shouldClear = argv.includes("--clear")
    const events = readFrictionEvents(repoRoot)
    const clusters = summarizeFrictionEvents(events)
    const proposals = []

    for (const cluster of clusters) {
      const proposal = yield* proposeLearningAction({
        kind: cluster.kind,
        summary: cluster.summary,
        detail: cluster.detail,
        occurrences: cluster.occurrences
      }).pipe(Effect.provide(decisionLayer))
      proposals.push({
        key: cluster.key,
        kind: cluster.kind,
        summary: cluster.summary,
        occurrences: cluster.occurrences,
        lastSeen: cluster.lastSeen,
        ...proposal
      })
    }

    if (shouldClear) {
      clearFrictionEvents(repoRoot)
    }

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        totalEvents: events.length,
        proposals,
        cleared: shouldClear
      }),
      stderr: ""
    }
  })

const handleOntology = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined,
  decisionLayer: Layer.Layer<DecisionModel.DecisionModel>
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
    const graph =
      options?.implGraph ?? (yield* extractWorkspaceTypeAwareGraph(repoRoot))
    const sub = argv[1] ?? "layers"

    switch (sub) {
      case "why": {
        const symbol = argv[2] ?? ""
        return {
          exitCode: 0,
          stdout: JSON.stringify(queryOntologyWhy(graph, symbol)),
          stderr: ""
        }
      }
      case "impact": {
        const symbol = argv[2] ?? ""
        return {
          exitCode: 0,
          stdout: JSON.stringify(queryOntologyImpact(graph, symbol)),
          stderr: ""
        }
      }
      case "layers": {
        const formatMermaid = argv.includes("--format=mermaid")
        return {
          exitCode: 0,
          stdout: formatMermaid
            ? renderOntologyMermaid(graph)
            : JSON.stringify(projectOntologyLayers(graph)),
          stderr: ""
        }
      }
      case "check": {
        const strict = argv.includes("--strict")
        const scopeArg = argv.find((arg) => arg.startsWith("--scope="))
        const scope = scopeArg ? scopeArg.slice("--scope=".length) : undefined

        const allDocs =
          options?.governanceDocs ?? loadGovernanceDocsFromDisk(repoRoot)
        const docs = scope
          ? allDocs.filter(
              (doc) =>
                doc.id.startsWith(`${scope}:`) ||
                doc.docPath.includes(`libs/${scope}/`) ||
                doc.docPath.includes(`apps/${scope}/`) ||
                doc.docPath.includes(`packages/${scope}/`)
            )
          : allDocs

        const invariants = yield* decideOntologyInvariants({
          graph,
          governanceDocs: docs
        })
        const pairs = extractOntologyConflictPairs(docs, scope)
        const semanticConflicts = yield* evaluateOntologyConflicts(pairs).pipe(
          Effect.provide(decisionLayer)
        )
        const clean = invariants.clean && semanticConflicts.length === 0

        return {
          exitCode: strict && !clean ? 1 : 0,
          stdout: JSON.stringify({
            clean,
            findings: invariants.findings,
            semanticConflicts,
            evaluatedPairs: pairs.length
          }),
          stderr: ""
        }
      }
      default: {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `unknown ontology subcommand: ${sub}\nusage: harness ontology <why|impact|layers|check>`
        }
      }
    }
  })

const handleReport = (
  argv: ReadonlyArray<string>,
  options: CliEnv | undefined
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    yield* Effect.void
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
      cumulative: argv.includes("--all")
    })
    if (options?.repoRoot !== undefined || process.env.VITEST === undefined) {
      writeSessionReportFiles(repoRoot, report)
    }
    if (argv.includes("--format=markdown")) {
      return {
        exitCode: 0,
        stdout: renderSessionReportMarkdown(report),
        stderr: ""
      }
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify(report),
      stderr: ""
    }
  })

export const runCliEffect = (
  argv: ReadonlyArray<string>,
  options?: CliEnv
): Effect.Effect<CliResult> =>
  Effect.gen(function* () {
    const requested = argv[0] ?? "help"
    const decisionLayer = options?.decisionLayer ?? LocalDecisionModel
    const repoRoot = options?.repoRoot ?? findWorkspaceRoot()

    if (options?.repoRoot === undefined && process.env.VITEST === undefined) {
      yield* Effect.try(() => {
        const harnessDir = join(CLI_REPO_ROOT, ".harness")
        mkdirSync(harnessDir, { recursive: true })
        writeFileSync(
          join(harnessDir, "active-workspace.json"),
          JSON.stringify({ repoRoot, updatedAt: new Date().toISOString() }, null, 2)
        )
      }).pipe(Effect.ignore)
    }

    if (!isCommand(requested)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `unknown command: ${requested}\nusage: harness <${COMMANDS.join("|")}>`
      }
    }

    if (requested === "help") {
      return {
        exitCode: 0,
        stdout: `harness help\nusage: harness <${COMMANDS.join("|")}>`,
        stderr: ""
      }
    }

    if (requested === "report") {
      return yield* handleReport(argv, options)
    }

    let resEffect: Effect.Effect<CliResult>
    switch (requested) {
      case "guard":
        resEffect = handleGuard(argv, options, decisionLayer)
        break
      case "route":
        resEffect = handleRoute(argv, options, decisionLayer)
        break
      case "plan-check":
        resEffect = handlePlanCheck(argv, options)
        break
      case "verify":
        resEffect = handleVerify(options, decisionLayer)
        break
      case "done":
        resEffect = handleDone(argv, options, decisionLayer)
        break
      case "learn":
        resEffect = handleLearn(argv, options, decisionLayer)
        break
      case "gc":
        resEffect = handleGc(argv, options)
        break
      case "mutate":
        resEffect = handleMutate(argv.slice(1), options)
        break
      case "ingest": {
        const repoRoot = options?.repoRoot ?? findWorkspaceRoot()
        const isAntigravity = argv.includes("--format=antigravity")
        resEffect = Effect.gen(function* () {
          const fnIndex = yield* buildWorkspaceFnIndex(repoRoot)
          return {
            exitCode: 0,
            stdout: isAntigravity
              ? JSON.stringify({})
              : JSON.stringify({ indexedFns: fnIndex.bySpanName.size }),
            stderr: ""
          }
        })
        break
      }
      case "session":
      case "doctor":
        resEffect = handleDoctorOrSession(argv, options, decisionLayer)
        break
      case "ontology":
        resEffect = handleOntology(argv, options, decisionLayer)
        break
    }

    const startTime = performance.now()
    const res = yield* resEffect
    const durationMs = Math.max(0, Math.round(performance.now() - startTime))

    const surface: TelemetrySurface =
      argv.includes("--format=antigravity") || options?.stdin !== undefined
        ? "hook"
        : "cli"

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
      requested === "mutate"
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
      ...(res.telemetryDetail !== undefined ? { detail: res.telemetryDetail } : {})
    })

    if (
      requested === "done" &&
      outcome === "ok" &&
      res.telemetryDetail !== "fullyIdle=false" &&
      (options?.repoRoot !== undefined || process.env.VITEST === undefined)
    ) {
      const finalEvents = readTelemetryEvents(repoRoot)
      const finalFriction = readFrictionEvents(repoRoot)
      const finalReport = buildSessionReport({
        events: finalEvents,
        frictionEvents: finalFriction,
        stampValid: true
      })
      writeSessionReportFiles(repoRoot, finalReport)
    }

    return res
  })

export const runCli = (
  argv: ReadonlyArray<string>,
  options?: CliEnv
): Promise<CliResult> => Effect.runPromise(runCliEffect(argv, options))

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
        process.stdout.write(
          res.stdout.endsWith("\n") ? res.stdout : res.stdout + "\n"
        )
      }
      if (res.stderr) {
        process.stderr.write(
          res.stderr.endsWith("\n") ? res.stderr : res.stderr + "\n"
        )
      }
      process.exit(res.exitCode)
    })
    .catch((err: unknown) => {
      console.error(String(err))
      process.exit(1)
    })
}
