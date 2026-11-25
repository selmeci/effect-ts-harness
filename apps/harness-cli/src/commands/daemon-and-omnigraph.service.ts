import { Effect, Layer, Option, Result, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { ErrorReasonMessage, StdinReadError, type StdinReadErrorKind } from "@harness/contract"
import type { GovernanceDocReference } from "@harness/gates"
import {
  appendFrictionEvent,
  appendTelemetryEvent,
  type FrictionEventKind,
  type TelemetryCategory,
  type TelemetryEngineSource,
  type TelemetryOutcome,
  type TelemetrySurface,
} from "@harness/gates/hook-fastpath"
import type { HarnessGraph } from "@harness/graph"
import {
  LocalDecisionModel,
  nodeSyncHostIo,
  queryUnixSocketLineDetailed,
  resolveHarnessDaemonSocketPath,
} from "@harness/infra/hook-fastpath"
import type { EmbeddingCachePort, EmbeddingClient } from "@harness/service"
import type {
  abortWorkflowViaDaemon,
  compileWorkflowPlanFromRepo,
  completeWorkflowViaDaemon,
  doctorWorkflowViaDaemon,
  getWorkflowStatusViaDaemon,
  resumeWorkflowViaDaemon,
  shipWorkflowViaDaemon,
  startWorkflowViaDaemon,
  validateWorktreeRepoRoot,
  WorkflowDaemonRpcOptions,
} from "@harness/infra"
import type { CliResult, HookStdinTracker } from "./hook-format.js"
export type { CliResult } from "./hook-format.js"
import {
  buildOmnigraphClusterKillArgs,
  CLI_REPO_ROOT,
  findWorkspaceRoot,
  isIsolatedExternalWorkspace,
  resolveClusterRepoRoot,
  resolveVerifyParallelCap,
  shouldSuppressLiveRepoTestSideEffects,
} from "./repo-path.js"

export {
  buildOmnigraphClusterKillArgs,
  CLI_REPO_ROOT,
  findWorkspaceRoot,
  isIsolatedExternalWorkspace,
  resolveClusterRepoRoot,
  resolveVerifyParallelCap,
  shouldSuppressLiveRepoTestSideEffects,
}

export const ensureLocalOmnigraphReady = (repoRoot: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: () => import("./omnigraph-lifecycle.js"),
    catch: (err): { readonly _tag: "OmnigraphImportFailure"; readonly message: string } => ({
      _tag: "OmnigraphImportFailure",
      message: err instanceof Error ? err.message : String(err),
    }),
  }).pipe(
    Effect.flatMap((m) => m.ensureLocalOmnigraphReady(repoRoot)),
    Effect.catch((err) =>
      Effect.sync(() => {
        process.stderr.write(
          `[harness:omnigraph] Warning: failed to load lifecycle module: ${err.message}\n`,
        )
        return false
      }),
    ),
  )

export const COMMANDS = [
  "guard",
  "route",
  "review-route",
  "plan-check",
  "plan-synth",
  "repair",
  "verify",
  "done",
  "learn",
  "gc",
  "mutate",
  "bench",
  "benchmark",
  "ingest",
  "session",
  "doctor",
  "ontology",
  "report",
  "check-openapi",
  "check-migrations",
  "check-event-schemas",
  "scenario",
  "workflow",
  "help",
] as const

export type Command = (typeof COMMANDS)[number]

export const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value)

export type WorkflowCliDeps = {
  readonly compilePlan?: typeof compileWorkflowPlanFromRepo | undefined
  readonly validateRepoRoot?: typeof validateWorktreeRepoRoot | undefined
  readonly startWorkflow?: typeof startWorkflowViaDaemon | undefined
  readonly getWorkflowStatus?: typeof getWorkflowStatusViaDaemon | undefined
  readonly completeWorkflow?: typeof completeWorkflowViaDaemon | undefined
  readonly resumeWorkflow?: typeof resumeWorkflowViaDaemon | undefined
  readonly shipWorkflow?: typeof shipWorkflowViaDaemon | undefined
  readonly doctorWorkflow?: typeof doctorWorkflowViaDaemon | undefined
  readonly abortWorkflow?: typeof abortWorkflowViaDaemon | undefined
  readonly daemonOptions?: WorkflowDaemonRpcOptions | undefined
}

export interface CliEnv {
  readonly repoRoot?: string | undefined
  readonly cwd?: string | undefined
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
  readonly skipBackgroundDaemons?: boolean | undefined
  readonly skipAutoSessionReport?: boolean | undefined
  readonly mutateStampPolicy?: "enforce" | "skip" | undefined
  readonly stdinTimeoutMs?: number | undefined
  readonly stdinMaxBytes?: number | undefined
  readonly governanceDocs?: ReadonlyArray<GovernanceDocReference> | undefined
  readonly hookStdinTracker?: HookStdinTracker | undefined
  readonly skipInitialSessionCacheRead?: boolean | undefined
  readonly embeddingClientLayer?: Layer.Layer<EmbeddingClient> | undefined
  readonly embeddingCacheLayer?: Layer.Layer<EmbeddingCachePort> | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly workflowDeps?: WorkflowCliDeps | undefined
}

export const resolveDecisionModelLayer = (
  maybeDecisionLayer?: Layer.Layer<DecisionModel.DecisionModel>,
): Effect.Effect<Layer.Layer<DecisionModel.DecisionModel>> =>
  Effect.gen(function* () {
    if (maybeDecisionLayer !== undefined) {
      return maybeDecisionLayer
    }
    const existing = yield* Effect.serviceOption(DecisionModel.DecisionModel)
    return match(existing)
      .with({ _tag: "Some" }, ({ value }) => Layer.succeed(DecisionModel.DecisionModel, value))
      .with({ _tag: "None" }, () => LocalDecisionModel)
      .exhaustive()
  })

export const resolveCommandTelemetryOutcome = (command: string, res: CliResult): TelemetryOutcome =>
  match(command)
    .with("guard", () => {
      if (res.exitCode !== 0 || res.stdout.includes('"decision":"deny"')) {
        return "deny" as const
      }
      if (
        res.stdout.includes('"decision":"ask"') ||
        res.stdout.includes('"permissionDecision":"ask"')
      ) {
        return "ask" as const
      }
      return "ok" as const
    })
    .with("done", () =>
      res.exitCode !== 0 ||
      res.stdout.includes('"decision":"continue"') ||
      res.stdout.includes('"decision":"block"')
        ? ("fail" as const)
        : ("ok" as const),
    )
    .with("route", () => {
      if (res.telemetryDetail?.includes("source=degraded-fallback")) {
        return "fallback" as const
      }
      if (res.telemetryDetail === undefined && res.stdout === "review") {
        return "fallback" as const
      }
      return "ok" as const
    })
    .otherwise(() => (res.exitCode === 0 ? ("ok" as const) : ("fail" as const)))

const DEFAULT_STDIN_TIMEOUT_MS = 4000
const DEFAULT_STDIN_MAX_BYTES = 2 * 1024 * 1024

export const makeReadStdinEffect = Effect.fn("HarnessCli.readStdin")(function* (stdinOptions?: {
  readonly timeoutMs?: number | undefined
  readonly maxBytes?: number | undefined
}): Effect.fn.Return<string, StdinReadError> {
  if (process.stdin.isTTY === true) {
    return ""
  }
  const timeoutMs = stdinOptions?.timeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS
  const maxBytes = stdinOptions?.maxBytes ?? DEFAULT_STDIN_MAX_BYTES
  return yield* Effect.callback<string, StdinReadError>((resume) => {
    const chunks: Array<Buffer> = []
    let totalBytes = 0
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined = undefined
    const cleanup = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
      process.stdin.off("data", onData)
      process.stdin.off("end", onEnd)
      process.stdin.off("error", onError)
      process.stdin.pause()
    }
    const succeed = (value: string) => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.succeed(value))
    }
    const fail = (reason: string, reasonKind: StdinReadErrorKind) => {
      if (settled) return
      settled = true
      cleanup()
      resume(
        Effect.fail(
          new StdinReadError({
            reason: ErrorReasonMessage.make(reason.trim() || "stdin read error"),
            reasonKind,
          }),
        ),
      )
    }
    const onData = (c: Buffer | string) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
      totalBytes += buf.byteLength
      if (totalBytes > maxBytes) {
        fail(`Stdin payload exceeded maximum size of ${maxBytes} bytes`, "MaxBytesExceeded")
        return
      }
      chunks.push(buf)
    }
    const onEnd = () => {
      succeed(Buffer.concat(chunks).toString("utf8"))
    }
    const onError = (err: unknown) => {
      fail(`Stdin stream error: ${err instanceof Error ? err.message : String(err)}`, "ReadFailed")
    }
    timeoutTimer = setTimeout(() => {
      fail(`Timed out reading stdin after ${timeoutMs}ms`, "Timeout")
    }, timeoutMs)
    process.stdin.on("data", onData)
    process.stdin.once("end", onEnd)
    process.stdin.once("error", onError)
    process.stdin.resume()
    return Effect.sync(cleanup)
  })
})

export const readStdinEffect: Effect.Effect<string, StdinReadError> = makeReadStdinEffect()

export const recordFriction = (
  options: CliEnv | undefined,
  event: {
    readonly kind: FrictionEventKind
    readonly summary: string
    readonly detail: string
  },
): void => {
  if (options?.repoRoot === undefined && options?.skipBackgroundDaemons === true) {
    return
  }
  const targetRoot = options?.repoRoot ?? findWorkspaceRoot()
  if (shouldSuppressLiveRepoTestSideEffects(targetRoot)) {
    return
  }
  appendFrictionEvent(targetRoot, event, nodeSyncHostIo)
}

export const recordTelemetry = (
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
  if (options?.repoRoot === undefined && options?.skipBackgroundDaemons === true) {
    return
  }
  const targetRoot = options?.repoRoot ?? findWorkspaceRoot()
  if (shouldSuppressLiveRepoTestSideEffects(targetRoot)) {
    return
  }
  appendTelemetryEvent(targetRoot, event, nodeSyncHostIo)
}

export const ANSI_REGEX = new RegExp(
  `[${String.fromCharCode(27)}${String.fromCharCode(155)}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g",
)

export const stripAnsiCodes = (text: string): string => text.replace(ANSI_REGEX, "")

export const cleanSubprocessError = (raw: string): string => {
  const noAnsi = stripAnsiCodes(raw)
  const filtered: Array<string> = []
  for (const line of noAnsi.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (
      trimmed.includes("[existing outputs match the cache, left as is]") ||
      /^✔\s+nx run\b/.test(trimmed) ||
      (trimmed.startsWith("Output of") && trimmed.includes("successful tasks were not shown")) ||
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
    const readStream = (v: unknown): string =>
      typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : ""
    const combined = [readStream(rec.stdout).trim(), readStream(rec.stderr).trim()]
      .filter(Boolean)
      .join("\n")
    raw = combined.length > 0 ? combined : typeof rec.message === "string" ? rec.message : ""
  } else {
    raw = String(err)
  }
  return cleanSubprocessError(raw)
}

const hasGitRef = (repoRoot: string, ref: string): boolean =>
  Result.getOrElse(
    Result.try(() => {
      const res = nodeSyncHostIo.execFileSync(
        "git",
        ["rev-parse", "--verify", "--end-of-options", ref],
        {
          cwd: repoRoot,
        },
      )
      return match(res)
        .with({ _tag: "Exited" }, ({ exitCode }) => exitCode === 0)
        .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => false)
        .exhaustive()
    }),
    () => false,
  )

export const resolveNxAffectedArgs = (
  repoRoot: string,
  targets: ReadonlyArray<string>,
  explicitFiles?: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const parallelArgs = targets.includes("verify")
    ? [`--parallel=${String(resolveVerifyParallelCap())}`]
    : []
  if (explicitFiles !== undefined && explicitFiles.length > 0) {
    return [
      "nx",
      "affected",
      `--files=${explicitFiles.join(",")}`,
      "-t",
      ...targets,
      ...parallelArgs,
    ]
  }
  if (hasGitRef(repoRoot, "main")) {
    return ["nx", "affected", "--base=main", "-t", ...targets, ...parallelArgs]
  }
  if (hasGitRef(repoRoot, "HEAD~1")) {
    return ["nx", "affected", "--base=HEAD~1", "-t", ...targets, ...parallelArgs]
  }
  return ["nx", "run-many", "-t", ...targets, ...parallelArgs]
}

export {
  collectAllWorkspaceSourceAndTestFiles,
  isRootConfigOrSharedCoreChange,
  readGitBranchDiffFiles,
  type ResolveModifiedFilesResult,
  resolveModifiedFilesSinceStampOrHead,
  tryGitDiffRange,
  type TryGitDiffRangeResult,
} from "./nx-affected-git.helpers.js"

export const tryQueryWarmDaemonSocket = (
  repoRoot: string,
  command: "ping" | "extract-graph" | "ast-gates" | "plan-check" | "gc" | "verify" | "bench",
  files?: ReadonlyArray<string>,
): Effect.Effect<Option.Option<Record<string, unknown>>> =>
  Effect.gen(function* () {
    const socketPath = resolveHarnessDaemonSocketPath(repoRoot)
    if (!nodeSyncHostIo.existsSync(socketPath)) {
      return Option.none()
    }
    const reqId = `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const payload = JSON.stringify({
      id: reqId,
      command,
      repoRoot,
      ...(files !== undefined ? { files } : {}),
    })
    const socketRes = yield* queryUnixSocketLineDetailed(socketPath, payload, 1500)
    return match(socketRes)
      .with({ _tag: "Reply" }, ({ line }) =>
        Schema.decodeOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
          line,
        ),
      )
      .with({ _tag: "Unavailable" }, ({ reason, detail }) => {
        match(reason)
          .with("timeout", "overflow", "socket-error", (unexpectedReason) => {
            process.stderr.write(
              `[harness:daemon] Socket query '${command}' failed (${unexpectedReason})${detail ? `: ${detail}` : ""}\n`,
            )
          })
          .with("missing-or-refused", "closed", () => undefined)
          .exhaustive()
        return Option.none<Record<string, unknown>>()
      })
      .exhaustive()
  })

export {
  checkOllamaServerReady,
  checkOllamaServerReadyDetailed,
  ensureLocalOllamaReady,
  type OllamaProbeResult,
  type OllamaReadinessOptions,
} from "./ollama-readiness.js"
