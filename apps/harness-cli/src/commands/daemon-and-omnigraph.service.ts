import { join, relative } from "node:path"
import { Effect, Layer, Option, Result, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import { ErrorReasonMessage, StdinReadError, type StdinReadErrorKind } from "@harness/contract"
import {
  appendFrictionEvent,
  appendTelemetryEvent,
  collectWorkspaceTsFiles,
  type FrictionEventKind,
  type GcFinding,
  type GovernanceDocReference,
  type TelemetryCategory,
  type TelemetryEngineSource,
  type TelemetryOutcome,
  type TelemetrySurface,
} from "@harness/gates"
import { type HarnessGraph, resolveCanonicalRepoRoot } from "@harness/graph"
import {
  LocalDecisionModel,
  nodeSyncHostIo,
  queryUnixSocketLineDetailed,
} from "@harness/infra"
import type { CliResult, HookStdinTracker } from "./hook-format.js"
export type { CliResult } from "./hook-format.js"

type SyncHostIo = typeof nodeSyncHostIo
import {
  buildOmnigraphClusterKillArgs,
  CLI_REPO_ROOT,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  resolveClusterRepoRoot,
} from "./omnigraph-lifecycle.js"

export {
  buildOmnigraphClusterKillArgs,
  CLI_REPO_ROOT,
  ensureLocalOmnigraphReady,
  findWorkspaceRoot,
  resolveClusterRepoRoot,
}

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
  "help",
] as const

export type Command = (typeof COMMANDS)[number]

export const isCommand = (value: string): value is Command =>
  (COMMANDS as readonly string[]).includes(value)

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
  readonly stdinTimeoutMs?: number | undefined
  readonly stdinMaxBytes?: number | undefined
  readonly governanceDocs?: ReadonlyArray<GovernanceDocReference> | undefined
  readonly hookStdinTracker?: HookStdinTracker | undefined
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

export const resolveCommandTelemetryOutcome = (
  command: string,
  res: CliResult,
): TelemetryOutcome =>
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

export const isIsolatedExternalWorkspace = (repoRoot: string): boolean => {
  if (nodeSyncHostIo.existsSync(join(repoRoot, "libs", "harness", "graph", "cluster.yaml"))) {
    return false
  }
  const explicitEnvUrl =
    process.env.OMNIGRAPH_URL && process.env.OMNIGRAPH_URL !== "http://127.0.0.1:8080"
  if (explicitEnvUrl) {
    return false
  }
  return (
    resolveCanonicalRepoRoot(repoRoot, nodeSyncHostIo) !==
    resolveCanonicalRepoRoot(CLI_REPO_ROOT, nodeSyncHostIo)
  )
}

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
  appendFrictionEvent(options?.repoRoot ?? findWorkspaceRoot(), event, nodeSyncHostIo)
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
  appendTelemetryEvent(options?.repoRoot ?? findWorkspaceRoot(), event, nodeSyncHostIo)
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
  const result = filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim()
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
      const res = nodeSyncHostIo.execFileSync("git", ["rev-parse", "--verify", ref], {
        cwd: repoRoot,
      })
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
  if (explicitFiles !== undefined && explicitFiles.length > 0) {
    return ["nx", "affected", `--files=${explicitFiles.join(",")}`, "-t", ...targets]
  }
  if (hasGitRef(repoRoot, "main")) {
    return ["nx", "affected", "--base=main", "-t", ...targets]
  }
  if (hasGitRef(repoRoot, "HEAD~1")) {
    return ["nx", "affected", "--base=HEAD~1", "-t", ...targets]
  }
  return ["nx", "run-many", "-t", ...targets]
}

export type TryGitDiffRangeResult =
  | { readonly _tag: "Ok"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "RefMissing" }
  | { readonly _tag: "GitFailed"; readonly reason: string }

const UNKNOWN_REVISION_RE =
  /unknown revision|bad revision|ambiguous argument|Needed a single revision|no merge base/i

const collectAllWorkspaceSourceAndTestFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
): ResolveModifiedFilesResult => {
  const findings: Array<GcFinding> = []
  const collected: Array<string> = []
  for (const rootDir of ["libs", "apps"] as const) {
    const absDir = join(repoRoot, rootDir)
    if (hostIo.existsSync(absDir)) {
      for (const absFile of collectWorkspaceTsFiles(absDir, hostIo, findings, repoRoot)) {
        collected.push(relative(repoRoot, absFile).replace(/\\/g, "/"))
      }
    }
  }
  if (findings.length > 0) {
    return {
      _tag: "GitFailed",
      reason: findings.map((f) => `[${f.kind}] ${f.location ?? f.nodeId}: ${f.message}`).join("; "),
    }
  }
  return { _tag: "Resolved", files: collected }
}

export const tryGitDiffRange = (
  repoRoot: string,
  range: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): TryGitDiffRangeResult =>
  Result.getOrElse(
    Result.try({
      try: (): TryGitDiffRangeResult => {
        const res = hostIo.execFileSync("git", ["diff", "--name-only", range], {
          cwd: repoRoot,
        })
        return match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => {
            if (exitCode === 0) {
              return {
                _tag: "Ok" as const,
                files: stdout
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0),
              }
            }
            if (UNKNOWN_REVISION_RE.test(stderr)) {
              return { _tag: "RefMissing" as const }
            }
            return {
              _tag: "GitFailed" as const,
              reason: `git diff ${range} failed (${stderr.trim() || `exit code ${exitCode}`})`,
            }
          })
          .with({ _tag: "TimedOut" }, () => ({
            _tag: "GitFailed" as const,
            reason: `git diff ${range} timed out`,
          }))
          .with({ _tag: "Signaled" }, ({ signal }) => ({
            _tag: "GitFailed" as const,
            reason: `git diff ${range} killed by signal ${signal}`,
          }))
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => ({
            _tag: "GitFailed" as const,
            reason: `git diff ${range} spawn failed: ${spawnError}`,
          }))
          .exhaustive()
      },
      catch: (err): TryGitDiffRangeResult => ({
        _tag: "GitFailed",
        reason: err instanceof Error ? err.message : String(err),
      }),
    }),
    (): TryGitDiffRangeResult => ({
      _tag: "GitFailed",
      reason: `git diff ${range} failed unexpectedly`,
    }),
  )

export const readGitBranchDiffFiles = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): ResolveModifiedFilesResult => {
  let sawOkEmpty = false
  for (const range of ["main...HEAD", "origin/main...HEAD", "HEAD~1...HEAD"]) {
    const res = tryGitDiffRange(repoRoot, range, hostIo)
    const outcome = match(res)
      .with({ _tag: "GitFailed" }, (failed) => failed)
      .with({ _tag: "Ok" }, ({ files }) => {
        if (files.length > 0) {
          return { _tag: "Resolved" as const, files }
        }
        sawOkEmpty = true
        return undefined
      })
      .with({ _tag: "RefMissing" }, () => undefined)
      .exhaustive()
    if (outcome !== undefined) {
      return outcome
    }
  }
  if (sawOkEmpty) {
    return { _tag: "Resolved", files: [] }
  }
  process.stderr.write(
    `[harness:verify] Warning: git branch diff refs unavailable in ${repoRoot}; falling back to scanning all workspace .ts/.tsx files.\n`,
  )
  return collectAllWorkspaceSourceAndTestFiles(repoRoot, hostIo)
}

export type ResolveModifiedFilesResult =
  | { readonly _tag: "Resolved"; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "GitFailed"; readonly reason: string }

export const resolveModifiedFilesSinceStampOrHead = (
  repoRoot: string,
  hostIo: SyncHostIo = nodeSyncHostIo,
): ResolveModifiedFilesResult =>
  Result.getOrElse(
    Result.try({
      try: (): ResolveModifiedFilesResult => {
        if (!hostIo.existsSync(join(repoRoot, ".git"))) {
          return collectAllWorkspaceSourceAndTestFiles(repoRoot, hostIo)
        }
        const files = new Set<string>()
        const res = hostIo.execFileSync("git", ["status", "--porcelain", "-uall"], {
          cwd: repoRoot,
        })
        const statusFailure = match(res)
          .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => {
            if (exitCode !== 0) {
              const detail = stderr.trim() || `exit code ${exitCode}`
              return `git status failed (${detail})`
            }
            for (const line of stdout.split(/\r?\n/)) {
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
            return undefined
          })
          .with({ _tag: "TimedOut" }, () => "git status timed out")
          .with({ _tag: "Signaled" }, ({ signal }) => `git status killed by signal ${signal}`)
          .with({ _tag: "SpawnFailed" }, ({ spawnError }) => `git status spawn failed: ${spawnError}`)
          .exhaustive()
        if (statusFailure !== undefined) {
          return { _tag: "GitFailed", reason: statusFailure }
        }
        const branchDiffResult = readGitBranchDiffFiles(repoRoot, hostIo)
        return match(branchDiffResult)
          .with({ _tag: "GitFailed" }, (failed) => failed)
          .with({ _tag: "Resolved" }, ({ files: diffFiles }) => {
            for (const diffFile of diffFiles) {
              files.add(diffFile.replace(/\\/g, "/"))
            }
            return { _tag: "Resolved" as const, files: Array.from(files) }
          })
          .exhaustive()
      },
      catch: (err): ResolveModifiedFilesResult => ({
        _tag: "GitFailed",
        reason: err instanceof Error ? err.message : String(err),
      }),
    }),
    (): ResolveModifiedFilesResult => ({
      _tag: "GitFailed",
      reason: "git status failed unexpectedly",
    }),
  )

export const isRootConfigOrSharedCoreChange = (modifiedFiles: ReadonlyArray<string>): boolean =>
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
