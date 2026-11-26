import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AgentExitCode,
  AgentExitError,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunnerError,
  AgentTimeoutError,
  AgentToolDeniedError,
  type RunnerId,
  RunnerProfile,
  TimeoutMillis,
  WORKFLOW_TIMEOUT_BUDGETS,
  toAgentDiagnosticDetail,
  toDenialNotice,
} from "@harness/contract"
import { resolveGitCommonDir } from "@harness/graph/cluster-resolver"
import { AgentRunnerPort, type AgentRunnerPortShape } from "@harness/service"
import type { ExtendedHostIo, SyncHostExecResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import {
  isRetryableAntigravityStartupFailure,
  parseAntigravityOutput,
  parseClaudeCodeOutput,
} from "./agent-runner-outcome.js"
import {
  reapOrphanAttemptProcessGroup,
  spawnSupervisedAgentProcess,
} from "./runner-process-supervision.js"
import {
  buildAntigravityArgv,
  buildClaudeCodeArgv,
  buildClaudeHooksSettingsJson,
  buildClaudeMcpConfigJson,
  buildRunnerEnv,
  getRunnerProfile,
  resolveHarnessInstallationRoot,
} from "./runner-profiles.js"

const MAX_MCP_CONFIG_BYTES = 65_536

const McpConfigJsonSchema = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
const decodeMcpConfigResult = Schema.decodeUnknownResult(McpConfigJsonSchema)
const encodeMcpConfig = Schema.encodeSync(McpConfigJsonSchema)

/** Injectable host/subprocess/env overrides for `ClaudeCodeRunnerLive`. */
export interface ClaudeCodeRunnerOptions {
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly timeoutMs?: number | undefined
  readonly killGraceMs?: number | undefined
  readonly harnessRoot?: string | undefined
  readonly pgidDir?: string | undefined
  readonly runProcess?:
    | ((
        cmd: string,
        args: ReadonlyArray<string>,
        opts: {
          readonly cwd: string
          readonly env: Readonly<Record<string, string | undefined>>
          readonly timeoutMs: number
          readonly killGraceMs: number
          readonly pgidRecordPath?: string | undefined
        },
      ) => Effect.Effect<SyncHostExecResult, AgentRunnerError>)
    | undefined
}

/** Injectable host/subprocess/retry/env overrides for `AntigravityRunnerLive`. */
export interface AntigravityRunnerOptions extends ClaudeCodeRunnerOptions {
  readonly startupRetryMaxAttempts?: number | undefined
  readonly startupRetryBackoffMs?: number | undefined
}

/** Combined injectable options for `makeAgentRunnerPortLayer`. */
export interface AgentRunnerPortOptions {
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly claudeOptions?: ClaudeCodeRunnerOptions | undefined
  readonly antigravityOptions?: AntigravityRunnerOptions | undefined
}

const resolvePgidBaseDir = (cwd: string, io: ExtendedHostIo, pgidDir?: string): string => {
  if (pgidDir !== undefined) {
    return pgidDir
  }
  const gitCommonDir = Result.getOrElse(
    Result.try(() => (io.existsSync(join(cwd, ".git")) ? resolveGitCommonDir(cwd, io) : null)),
    () => null,
  )
  return gitCommonDir !== null
    ? join(gitCommonDir, "harness", "runner-pgids")
    : join(tmpdir(), "harness-runner-pgids")
}

const makeRunnerPgidRecordPath = (
  request: AgentRunRequest,
  io: ExtendedHostIo,
  pgidDir?: string,
): string | undefined =>
  request.runId !== undefined
    ? join(
        resolvePgidBaseDir(request.cwd, io, pgidDir),
        `${request.runId}-${request.brief.unitId}-${request.brief.attempt}.json`,
      )
    : undefined

const loadValidatedMcpConfigJson = (
  io: ExtendedHostIo,
  providedMcpConfigPath: string,
): Effect.Effect<string, AgentRunnerError> => {
  if (io.isSymbolicLinkSync(providedMcpConfigPath) || !io.isFileSync(providedMcpConfigPath)) {
    return Effect.fail(
      new AgentExitError({
        runner: "claude-code",
        exit: AgentExitCode.make(1),
        detail: toAgentDiagnosticDetail(
          `Invalid or missing mcpConfigPath '${providedMcpConfigPath}'`,
        ),
      }),
    )
  }

  const realPathRes = Result.try({
    try: () => io.realpathSync(providedMcpConfigPath),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  const realPath = match(realPathRes)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()
  if (realPath === undefined || realPath !== providedMcpConfigPath) {
    return Effect.fail(
      new AgentExitError({
        runner: "claude-code",
        exit: AgentExitCode.make(1),
        detail: toAgentDiagnosticDetail(
          `Refusing symlinked or non-canonical mcpConfigPath '${providedMcpConfigPath}'`,
        ),
      }),
    )
  }

  const bytesRes = Result.try({
    try: () =>
      Buffer.from(io.readBytesPrefixSync(providedMcpConfigPath, MAX_MCP_CONFIG_BYTES)).toString(
        "utf8",
      ),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return match(bytesRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        new AgentExitError({
          runner: "claude-code",
          exit: AgentExitCode.make(1),
          detail: toAgentDiagnosticDetail(
            `Failed to read mcpConfigPath '${providedMcpConfigPath}': ${failure}`,
          ),
        }),
      ),
    )
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(decodeMcpConfigResult(raw))
        .with({ _tag: "Failure" }, ({ failure }) =>
          Effect.fail(
            new AgentExitError({
              runner: "claude-code",
              exit: AgentExitCode.make(1),
              detail: toAgentDiagnosticDetail(
                `Invalid JSON in mcpConfigPath '${providedMcpConfigPath}': ${String(failure)}`,
              ),
            }),
          ),
        )
        .with({ _tag: "Success" }, ({ success }) => Effect.succeed(encodeMcpConfig(success)))
        .exhaustive(),
    )
    .exhaustive()
}

const mapExecResult = (
  runner: RunnerId,
  timeoutMs: number,
  execRes: SyncHostExecResult,
  parseOutput: (
    exitCode: number,
    stdout: string,
    stderr: string,
  ) => Result.Result<AgentRunResult, AgentRunnerError>,
): Effect.Effect<AgentRunResult, AgentRunnerError> =>
  match(execRes)
    .with({ _tag: "TimedOut" }, () =>
      Effect.fail(
        new AgentTimeoutError({
          runner,
          afterMillis: TimeoutMillis.make(Math.max(1, Math.round(timeoutMs))),
        }),
      ),
    )
    .with({ _tag: "Signaled" }, ({ signal, stderr }) =>
      Effect.fail(
        new AgentExitError({
          runner,
          exit: AgentExitCode.make(1),
          detail: toAgentDiagnosticDetail(
            stderr.trim().length > 0
              ? `Terminated by signal ${signal}: ${stderr.trim()}`
              : `Terminated by signal ${signal}`,
          ),
        }),
      ),
    )
    .with({ _tag: "SpawnFailed" }, ({ spawnError, stderr }) =>
      Effect.fail(
        new AgentExitError({
          runner,
          exit: AgentExitCode.make(1),
          detail: toAgentDiagnosticDetail(
            stderr.trim().length > 0 ? `${spawnError}: ${stderr.trim()}` : spawnError,
          ),
        }),
      ),
    )
    .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) =>
      match(parseOutput(exitCode, stdout, stderr))
        .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
        .with({ _tag: "Failure" }, ({ failure }) => Effect.fail(failure))
        .exhaustive(),
    )
    .exhaustive()

const writeTempConfigFile = (
  io: ExtendedHostIo,
  filePath: string,
  content: string,
): Effect.Effect<void, AgentRunnerError> =>
  Effect.try({
    try: () => {
      io.writeTextWithModeSync(filePath, content, 0o600)
    },
    catch: (err) =>
      new AgentExitError({
        runner: "claude-code",
        exit: AgentExitCode.make(1),
        detail: toAgentDiagnosticDetail(
          `Failed to write scoped runner config '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        ),
      }),
  })

/** Executes an automatic unit via `claude -p` (`REQ-4.1`, `REQ-4.2`). */
export const runClaudeCodeImpl = Effect.fn("ClaudeCodeRunner.run")(function* (
  request: AgentRunRequest,
  options?: ClaudeCodeRunnerOptions,
): Effect.fn.Return<AgentRunResult, AgentRunnerError> {
  const io = options?.hostIo ?? nodeSyncHostIo
  const parentEnv = options?.env ?? io.getEnv()
  const profile = getRunnerProfile("claude-code")
  const timeoutMs = options?.timeoutMs ?? profile.timeoutMillis
  const killGraceMs = options?.killGraceMs ?? WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs
  const harnessRoot = options?.harnessRoot ?? resolveHarnessInstallationRoot()
  const pgidRecordPath = makeRunnerPgidRecordPath(request, io, options?.pgidDir)

  if (pgidRecordPath !== undefined) {
    yield* reapOrphanAttemptProcessGroup(pgidRecordPath, io)
  }

  const providedMcpConfigPath = request.brief.mcpConfigPath
  const validatedMcpJson =
    providedMcpConfigPath !== undefined
      ? yield* loadValidatedMcpConfigJson(io, providedMcpConfigPath)
      : undefined

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tempDir = yield* Effect.acquireRelease(
        Effect.try({
          try: () => io.mkdtempSync("harness-claude-"),
          catch: (err) =>
            new AgentExitError({
              runner: "claude-code",
              exit: AgentExitCode.make(1),
              detail: toAgentDiagnosticDetail(
                `Failed to create temporary Claude config directory: ${err instanceof Error ? err.message : String(err)}`,
              ),
            }),
        }),
        (dir) =>
          Effect.sync(() => {
            const rmRes = Result.try({
              try: () => {
                io.rmRecursiveSync(dir)
              },
              catch: (err) => (err instanceof Error ? err.message : String(err)),
            })
            match(rmRes)
              .with({ _tag: "Success" }, () => undefined)
              .with({ _tag: "Failure" }, ({ failure }) => {
                process.stderr.write(
                  `[harness/infra] Failed to remove temporary Claude config dir '${dir}': ${failure}\n`,
                )
              })
              .exhaustive()
          }),
      )

      const hooksSettingsPath = join(tempDir, "hooks.json")
      yield* writeTempConfigFile(io, hooksSettingsPath, buildClaudeHooksSettingsJson(harnessRoot))

      const mcpConfigPath = join(tempDir, "mcp.json")
      const mcpConfigContent =
        validatedMcpJson !== undefined
          ? validatedMcpJson
          : buildClaudeMcpConfigJson(undefined, harnessRoot)
      yield* writeTempConfigFile(io, mcpConfigPath, mcpConfigContent)

      const argv = buildClaudeCodeArgv({
        profile,
        promptText: request.brief.promptText,
        mcpConfigPath,
        hooksSettingsPath,
      })
      const childEnv = buildRunnerEnv("claude-code", parentEnv)
      const execProcess =
        options?.runProcess ??
        ((cmd: string, args: ReadonlyArray<string>, opts) =>
          spawnSupervisedAgentProcess(cmd, args, {
            ...opts,
            hostIo: io,
            runner: "claude-code",
          }))

      const execRes = yield* execProcess(profile.binary, argv, {
        cwd: request.cwd,
        env: childEnv,
        timeoutMs,
        killGraceMs,
        ...(pgidRecordPath !== undefined ? { pgidRecordPath } : {}),
      })

      return yield* mapExecResult("claude-code", timeoutMs, execRes, parseClaudeCodeOutput)
    }),
  )
})

/** Executes an automatic unit via `agy -p` (`REQ-4.1`, `REQ-4.3`). */
export const runAntigravityImpl = Effect.fn("AntigravityRunner.run")(function* (
  request: AgentRunRequest,
  options?: AntigravityRunnerOptions,
): Effect.fn.Return<AgentRunResult, AgentRunnerError> {
  if (request.mcpIsolation === "hard") {
    return yield* match(request.hardMcpFallback ?? "reject")
      .with("reject", () =>
        Effect.fail(
          new AgentToolDeniedError({
            runner: "antigravity",
            notice: toDenialNotice(
              "Antigravity runner does not support hard MCP isolation; use 'claude-code' or hardMcpFallback='fallback-claude'",
            ),
          }),
        ),
      )
      .with("fallback-claude", () =>
        runClaudeCodeImpl(
          {
            ...request,
            runner: "claude-code",
          },
          options,
        ),
      )
      .exhaustive()
  }

  const io = options?.hostIo ?? nodeSyncHostIo
  const parentEnv = options?.env ?? io.getEnv()
  const baseProfile = getRunnerProfile("antigravity")
  const timeoutMs = options?.timeoutMs ?? baseProfile.timeoutMillis
  const effectiveProfile =
    timeoutMs !== baseProfile.timeoutMillis
      ? RunnerProfile.make({
          ...baseProfile,
          timeoutMillis: TimeoutMillis.make(Math.max(1, Math.round(timeoutMs))),
        })
      : baseProfile
  const killGraceMs = options?.killGraceMs ?? WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs
  const rawMaxAttempts =
    options?.startupRetryMaxAttempts ?? WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryMaxAttempts
  const maxAttempts = Number.isFinite(rawMaxAttempts)
    ? Math.max(1, Math.floor(rawMaxAttempts))
    : WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryMaxAttempts
  const rawBackoffMs =
    options?.startupRetryBackoffMs ?? WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryBackoffMs
  const backoffMs = Number.isFinite(rawBackoffMs)
    ? Math.max(0, Math.floor(rawBackoffMs))
    : WORKFLOW_TIMEOUT_BUDGETS.agentStartupRetryBackoffMs
  const pgidRecordPath = makeRunnerPgidRecordPath(request, io, options?.pgidDir)

  if (pgidRecordPath !== undefined) {
    yield* reapOrphanAttemptProcessGroup(pgidRecordPath, io)
  }

  const argv = buildAntigravityArgv({
    profile: effectiveProfile,
    promptText: request.brief.promptText,
  })
  const childEnv = buildRunnerEnv("antigravity", parentEnv)
  const execProcess =
    options?.runProcess ??
    ((cmd: string, args: ReadonlyArray<string>, opts) =>
      spawnSupervisedAgentProcess(cmd, args, {
        ...opts,
        hostIo: io,
        runner: "antigravity",
      }))

  const runAttempt = (attemptIdx: number): Effect.Effect<AgentRunResult, AgentRunnerError> =>
    Effect.gen(function* () {
      const execRes = yield* execProcess(effectiveProfile.binary, argv, {
        cwd: request.cwd,
        env: childEnv,
        timeoutMs,
        killGraceMs,
        ...(pgidRecordPath !== undefined ? { pgidRecordPath } : {}),
      })
      const shouldRetry = match(execRes)
        .with(
          { _tag: "Exited" },
          ({ exitCode, stdout, stderr }) =>
            attemptIdx < maxAttempts &&
            isRetryableAntigravityStartupFailure(exitCode, stdout, stderr),
        )
        .with({ _tag: "TimedOut" }, { _tag: "Signaled" }, { _tag: "SpawnFailed" }, () => false)
        .exhaustive()

      if (shouldRetry) {
        if (backoffMs > 0) {
          yield* Effect.sleep(`${backoffMs} millis`)
        }
        return yield* runAttempt(attemptIdx + 1)
      }

      return yield* mapExecResult("antigravity", timeoutMs, execRes, parseAntigravityOutput)
    })

  return yield* runAttempt(1)
})

const mergeClaudeOptions = (
  options?: AgentRunnerPortOptions,
): ClaudeCodeRunnerOptions | undefined =>
  options === undefined
    ? undefined
    : {
        ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...options.claudeOptions,
      }

const mergeAntigravityOptions = (
  options?: AgentRunnerPortOptions,
): AntigravityRunnerOptions | undefined =>
  options === undefined
    ? undefined
    : {
        ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...options.antigravityOptions,
      }

/** Dispatches `AgentRunRequest` to `ClaudeCodeRunnerLive` or `AntigravityRunnerLive` exhaustively (`REQ-4.1`). */
export const runAgentRunnerImpl = Effect.fn("AgentRunner.run")(function* (
  request: AgentRunRequest,
  options?: AgentRunnerPortOptions,
): Effect.fn.Return<AgentRunResult, AgentRunnerError> {
  return yield* match(request.runner)
    .with("claude-code", () => runClaudeCodeImpl(request, mergeClaudeOptions(options)))
    .with("antigravity", () => runAntigravityImpl(request, mergeAntigravityOptions(options)))
    .exhaustive()
})

/** Builds a parameterized `AgentRunnerPort` layer. */
const makeAgentRunnerPortLayer = (options?: AgentRunnerPortOptions): Layer.Layer<AgentRunnerPort> =>
  Layer.succeed(AgentRunnerPort, {
    run: (request) => runAgentRunnerImpl(request, options),
  } satisfies AgentRunnerPortShape)

/** Builds a Claude-only `AgentRunnerPort` layer. */
const makeClaudeCodeRunnerLayer = (
  options?: ClaudeCodeRunnerOptions,
): Layer.Layer<AgentRunnerPort> =>
  Layer.succeed(AgentRunnerPort, {
    run: (request) =>
      match(request.runner)
        .with("claude-code", () => runClaudeCodeImpl(request, options))
        .with("antigravity", () =>
          Effect.fail(
            new AgentExitError({
              runner: request.runner,
              exit: AgentExitCode.make(1),
              detail: toAgentDiagnosticDetail(
                "ClaudeCodeRunner cannot execute request for runner 'antigravity'",
              ),
            }),
          ),
        )
        .exhaustive(),
  } satisfies AgentRunnerPortShape)

/** Builds an Antigravity-only `AgentRunnerPort` layer. */
const makeAntigravityRunnerLayer = (
  options?: AntigravityRunnerOptions,
): Layer.Layer<AgentRunnerPort> =>
  Layer.succeed(AgentRunnerPort, {
    run: (request) =>
      match(request.runner)
        .with("antigravity", () => runAntigravityImpl(request, options))
        .with("claude-code", () =>
          Effect.fail(
            new AgentExitError({
              runner: request.runner,
              exit: AgentExitCode.make(1),
              detail: toAgentDiagnosticDetail(
                "AntigravityRunner cannot execute request for runner 'claude-code'",
              ),
            }),
          ),
        )
        .exhaustive(),
  } satisfies AgentRunnerPortShape)

/** Live `AgentRunnerPort` layer dispatching over `claude-code` and `antigravity`. */
export const AgentRunnerPortLive: Layer.Layer<AgentRunnerPort> = makeAgentRunnerPortLayer()

/** Dedicated Claude Code runner layer (`REQ-4.2`). */
export const ClaudeCodeRunnerLive: Layer.Layer<AgentRunnerPort> = makeClaudeCodeRunnerLayer()

/** Dedicated Antigravity runner layer (`REQ-4.3`). */
export const AntigravityRunnerLive: Layer.Layer<AgentRunnerPort> = makeAntigravityRunnerLayer()

export { makeAgentRunnerPortLayer, makeAntigravityRunnerLayer, makeClaudeCodeRunnerLayer }
