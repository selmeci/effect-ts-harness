import { join, relative } from "node:path"
import { Effect, Layer, Option, Result, Schema } from "effect"
import * as DecisionModel from "effect/ai/DecisionModel"
import { match } from "ts-pattern"
import {
  appendFrictionEvent,
  appendTelemetryEvent,
  collectModularPluginFiles,
  type FrictionEventKind,
  type GovernanceDocReference,
  type TelemetryCategory,
  type TelemetryEngineSource,
  type TelemetryOutcome,
  type TelemetrySurface,
} from "@harness/gates"
import { type HarnessGraph, resolveCanonicalRepoRoot } from "@harness/graph"
import { nodeSyncHostIo, queryUnixSocketLine } from "@harness/infra"
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

export const readStdinEffect: Effect.Effect<string> = Effect.callback<string>((resume) => {
  const chunks: Array<Buffer> = []
  let hasData = false
  let settled = false
  const cleanup = () => {
    clearTimeout(idleTimer)
    process.stdin.off("data", onData)
    process.stdin.off("end", onEnd)
    process.stdin.off("error", onError)
  }
  const finish = (value: string) => {
    if (settled) return
    settled = true
    cleanup()
    resume(Effect.succeed(value))
  }
  const onData = (c: Buffer | string) => {
    hasData = true
    clearTimeout(idleTimer)
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
  }
  const onEnd = () => {
    finish(Buffer.concat(chunks).toString("utf8"))
  }
  const onError = () => {
    finish("")
  }
  const idleTimer = setTimeout(() => {
    if (!hasData) {
      process.stdin.pause()
      finish("")
    }
  }, 50)
  process.stdin.on("data", onData)
  process.stdin.once("end", onEnd)
  process.stdin.once("error", onError)
  process.stdin.resume()
  return Effect.sync(cleanup)
})

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
  if (options?.repoRoot === undefined && process.env.VITEST !== undefined) {
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
  if (options?.repoRoot === undefined && process.env.VITEST !== undefined) {
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
      return res.exitCode === 0
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

export const tryGitDiffRange = (
  repoRoot: string,
  range: string,
): Option.Option<ReadonlyArray<string>> =>
  Result.getOrElse(
    Result.try(() => {
      const res = nodeSyncHostIo.execFileSync("git", ["diff", "--name-only", range], {
        cwd: repoRoot,
      })
      if (res.exitCode !== 0) {
        return Option.none<ReadonlyArray<string>>()
      }
      return Option.some(
        res.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      )
    }),
    () => Option.none<ReadonlyArray<string>>(),
  )

export const readGitBranchDiffFiles = (repoRoot: string): ReadonlyArray<string> => {
  for (const range of ["main...HEAD", "origin/main...HEAD", "HEAD~1...HEAD"]) {
    const opt = tryGitDiffRange(repoRoot, range)
    const nonEmpty = match(opt)
      .with({ _tag: "Some" }, ({ value }) => (value.length > 0 ? value : undefined))
      .with({ _tag: "None" }, () => undefined)
      .exhaustive()
    if (nonEmpty !== undefined) {
      return nonEmpty
    }
  }
  if (nodeSyncHostIo.existsSync(join(repoRoot, "libs", "harness", "gates", "src"))) {
    process.stderr.write(
      `[harness:verify] Warning: git branch diff failed or returned empty in ${repoRoot}; falling back to scanning all modular gate files.\n`,
    )
    return collectModularPluginFiles(repoRoot, nodeSyncHostIo).map((abs) =>
      relative(repoRoot, abs).replace(/\\/g, "/"),
    )
  }
  return []
}

export const resolveModifiedFilesSinceStampOrHead = (repoRoot: string): ReadonlyArray<string> =>
  Result.getOrElse(
    Result.try(() => {
      const files = new Set<string>()
      const res = nodeSyncHostIo.execFileSync("git", ["status", "--porcelain", "-uall"], {
        cwd: repoRoot,
      })
      if (res.exitCode === 0) {
        for (const line of res.stdout.split(/\r?\n/)) {
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
      }
      for (const diffFile of readGitBranchDiffFiles(repoRoot)) {
        files.add(diffFile.replace(/\\/g, "/"))
      }
      return Array.from(files)
    }),
    () => [],
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
    const lineOpt = yield* queryUnixSocketLine(socketPath, payload, 1500)
    return Option.flatMap(lineOpt, (line) =>
      Schema.decodeOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(line),
    )
  })

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
        .then((r) =>
          match(r.status)
            .with(200, () =>
              r.json().then((rawBody: unknown) => {
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
              }),
            )
            .otherwise(() => Promise.resolve(false)),
        )
        .catch(() => false),
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))
}

export function ensureLocalOllamaReady(opts?: OllamaReadinessOptions): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const customUrl = process.env.HARNESS_OLLAMA_URL
    const baseUrl =
      opts?.baseUrl ?? customUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"
    if (yield* checkOllamaServerReady(baseUrl)) {
      return true
    }

    yield* Effect.try({
      try: () => {
        if (opts?.spawnOllama !== undefined) {
          opts.spawnOllama()
        } else {
          if (customUrl === undefined) {
            nodeSyncHostIo.spawnDetached("ollama", ["serve"])
          }
        }
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))

    const maxRetries = opts?.maxRetries ?? (customUrl !== undefined ? 2 : 25)
    const retryDelayMs = opts?.retryDelayMs ?? (customUrl !== undefined ? 10 : 200)
    for (let i = 0; i < maxRetries; i++) {
      yield* Effect.sleep(`${retryDelayMs} millis`)
      if (yield* checkOllamaServerReady(baseUrl)) {
        return true
      }
    }
    return false
  })
}
