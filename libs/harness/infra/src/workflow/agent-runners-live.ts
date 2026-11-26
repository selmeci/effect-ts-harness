import { lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Result, Schema, Semaphore } from "effect"
import { match } from "ts-pattern"
import {
  AgentExitError,
  AgentNonZeroExitCode,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunnerError,
  AgentTimeoutError,
  AgentToolDeniedError,
  type AntigravityRunRequest,
  AntigravityRunnerProfile,
  type ClaudeCodeRunRequest,
  RunnerConfigFilePath,
  type RunnerId,
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
  ANTIGRAVITY_RUNNER_PROFILE,
  CLAUDE_CODE_RUNNER_PROFILE,
  buildAntigravityArgv,
  buildClaudeCodeArgv,
  buildClaudeHooksSettingsJson,
  buildClaudeMcpConfigJson,
  buildRunnerEnv,
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
  readonly statUidSync?: ((filePath: string) => number | undefined) | undefined
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

const defaultStatUidSync = (targetPath: string): number | undefined =>
  lstatSync(targetPath, { throwIfNoEntry: false })?.uid

const resolveFallbackPgidDir = (
  io: ExtendedHostIo,
  runner: RunnerId,
  statUidSync?: (filePath: string) => number | undefined,
): Effect.Effect<string, AgentRunnerError> =>
  Effect.gen(function* () {
    const uidSuffix = typeof process.getuid === "function" ? String(process.getuid()) : "user"
    const fallbackDir = join(tmpdir(), `harness-runner-pgids-${uidSuffix}`)
    if (io.isSymbolicLinkSync(fallbackDir)) {
      return yield* new AgentExitError({
        runner,
        exit: AgentNonZeroExitCode.make(1),
        kind: "exit",
        detail: toAgentDiagnosticDetail(
          `Refusing symlink fallback PGID directory '${fallbackDir}'`,
        ),
      })
    }

    const mkdirRes = Result.try({
      try: () => {
        io.mkdirRecursiveSync(fallbackDir, 0o700)
      },
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    })
    yield* match(mkdirRes)
      .with({ _tag: "Success" }, () => Effect.void)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(
          new AgentExitError({
            runner,
            exit: AgentNonZeroExitCode.make(1),
            kind: "exit",
            detail: toAgentDiagnosticDetail(
              `Failed to create fallback PGID directory '${fallbackDir}': ${failure}`,
            ),
          }),
        ),
      )
      .exhaustive()

    if (io.isSymbolicLinkSync(fallbackDir) || !io.isDirectorySync(fallbackDir)) {
      return yield* new AgentExitError({
        runner,
        exit: AgentNonZeroExitCode.make(1),
        kind: "exit",
        detail: toAgentDiagnosticDetail(
          `Fallback PGID path '${fallbackDir}' is a symlink or not a directory`,
        ),
      })
    }

    if (process.platform !== "win32") {
      const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined
      if (currentUid !== undefined) {
        const readUid = statUidSync ?? defaultStatUidSync
        const dirUid = Result.getOrElse(
          Result.try(() => readUid(fallbackDir)),
          () => undefined,
        )
        if (dirUid !== currentUid) {
          return yield* new AgentExitError({
            runner,
            exit: AgentNonZeroExitCode.make(1),
            kind: "exit",
            detail: toAgentDiagnosticDetail(
              `Refusing fallback PGID directory '${fallbackDir}' not owned by uid ${currentUid} (actual=${String(dirUid)})`,
            ),
          })
        }
      }

      const dirMode = io.statModeSync(fallbackDir)
      if (dirMode === undefined || (dirMode & 0o077) !== 0) {
        return yield* new AgentExitError({
          runner,
          exit: AgentNonZeroExitCode.make(1),
          kind: "exit",
          detail: toAgentDiagnosticDetail(
            `Refusing insecure permissions on fallback PGID directory '${fallbackDir}' (expected 0o700)`,
          ),
        })
      }
    }

    return fallbackDir
  })

const resolvePgidBaseDir = (
  cwd: string,
  io: ExtendedHostIo,
  runner: RunnerId,
  pgidDir?: string,
  statUidSync?: (filePath: string) => number | undefined,
): Effect.Effect<string, AgentRunnerError> => {
  if (pgidDir !== undefined) {
    return Effect.succeed(pgidDir)
  }
  const gitCommonDir = Result.getOrElse(
    Result.try(() => (io.existsSync(join(cwd, ".git")) ? resolveGitCommonDir(cwd, io) : null)),
    () => null,
  )
  return gitCommonDir !== null
    ? Effect.succeed(join(gitCommonDir, "harness", "runner-pgids"))
    : resolveFallbackPgidDir(io, runner, statUidSync)
}

const makeRunnerPgidRecordPath = (
  request: AgentRunRequest,
  io: ExtendedHostIo,
  pgidDir?: string,
  statUidSync?: (filePath: string) => number | undefined,
): Effect.Effect<string, AgentRunnerError> =>
  resolvePgidBaseDir(request.cwd, io, request.runner, pgidDir, statUidSync).pipe(
    Effect.map((baseDir) =>
      join(baseDir, `${request.runId}-${request.brief.unitId}-${request.brief.attempt}.json`),
    ),
  )

const loadValidatedMcpConfigJson = (
  io: ExtendedHostIo,
  providedMcpConfigPath: string,
): Effect.Effect<string, AgentRunnerError> =>
  Effect.gen(function* () {
    if (io.isSymbolicLinkSync(providedMcpConfigPath) || !io.isFileSync(providedMcpConfigPath)) {
      return yield* new AgentExitError({
        runner: "claude-code",
        exit: AgentNonZeroExitCode.make(1),
        kind: "exit",
        detail: toAgentDiagnosticDetail(
          `Invalid or missing mcpConfigPath '${providedMcpConfigPath}'`,
        ),
      })
    }

    const realPathRes = Result.try({
      try: () => io.realpathSync(providedMcpConfigPath),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    })
    yield* match(realPathRes)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(
          new AgentExitError({
            runner: "claude-code",
            exit: AgentNonZeroExitCode.make(1),
            kind: "exit",
            detail: toAgentDiagnosticDetail(
              `Failed to canonicalize mcpConfigPath '${providedMcpConfigPath}': ${failure}`,
            ),
          }),
        ),
      )
      .with({ _tag: "Success" }, ({ success: realPath }) =>
        realPath !== providedMcpConfigPath
          ? Effect.fail(
              new AgentExitError({
                runner: "claude-code",
                exit: AgentNonZeroExitCode.make(1),
                kind: "exit",
                detail: toAgentDiagnosticDetail(
                  `Refusing symlinked or non-canonical mcpConfigPath '${providedMcpConfigPath}' (resolved to '${realPath}')`,
                ),
              }),
            )
          : Effect.void,
      )
      .exhaustive()

    const bytesRes = Result.try({
      try: () => io.readBytesPrefixSync(providedMcpConfigPath, MAX_MCP_CONFIG_BYTES + 1),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    })
    return yield* match(bytesRes)
      .with({ _tag: "Failure" }, ({ failure }) =>
        Effect.fail(
          new AgentExitError({
            runner: "claude-code",
            exit: AgentNonZeroExitCode.make(1),
            kind: "exit",
            detail: toAgentDiagnosticDetail(
              `Failed to read mcpConfigPath '${providedMcpConfigPath}': ${failure}`,
            ),
          }),
        ),
      )
      .with({ _tag: "Success" }, ({ success: bytes }) => {
        if (bytes.length > MAX_MCP_CONFIG_BYTES) {
          return Effect.fail(
            new AgentExitError({
              runner: "claude-code",
              exit: AgentNonZeroExitCode.make(1),
              kind: "exit",
              detail: toAgentDiagnosticDetail(
                `mcpConfigPath '${providedMcpConfigPath}' exceeds ${MAX_MCP_CONFIG_BYTES} bytes limit`,
              ),
            }),
          )
        }
        const raw = Buffer.from(bytes).toString("utf8")
        return match(decodeMcpConfigResult(raw))
          .with({ _tag: "Failure" }, ({ failure }) =>
            Effect.fail(
              new AgentExitError({
                runner: "claude-code",
                exit: AgentNonZeroExitCode.make(1),
                kind: "exit",
                detail: toAgentDiagnosticDetail(
                  `Invalid JSON in mcpConfigPath '${providedMcpConfigPath}': ${String(failure)}`,
                ),
              }),
            ),
          )
          .with({ _tag: "Success" }, ({ success }) => Effect.succeed(encodeMcpConfig(success)))
          .exhaustive()
      })
      .exhaustive()
  })

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
          exit: AgentNonZeroExitCode.make(1),
          kind: "signal",
          detail: toAgentDiagnosticDetail(
            stderr.trim().length > 0
              ? `Terminated by signal ${signal}: ${stderr.trim()}`
              : `Terminated by signal ${signal}`,
          ),
        }),
      ),
    )
    .with({ _tag: "SpawnFailed" }, ({ spawnError, stderr }) => {
      const binaryName = match(runner)
        .with("claude-code", () => "claude")
        .with("antigravity", () => "agy")
        .exhaustive()
      const baseMsg = stderr.trim().length > 0 ? `${spawnError}: ${stderr.trim()}` : spawnError
      return Effect.fail(
        new AgentExitError({
          runner,
          exit: AgentNonZeroExitCode.make(1),
          kind: "spawn-failed",
          detail: toAgentDiagnosticDetail(
            `${baseMsg} — ensure '${binaryName}' is installed and executable on PATH (run 'pnpm harness workflow doctor')`,
          ),
        }),
      )
    })
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
        exit: AgentNonZeroExitCode.make(1),
        kind: "exit",
        detail: toAgentDiagnosticDetail(
          `Failed to write scoped runner config '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
        ),
      }),
  })

const toClaudeFallbackOptions = (
  options?: AntigravityRunnerOptions,
): ClaudeCodeRunnerOptions | undefined =>
  options === undefined
    ? undefined
    : {
        ...(options.hostIo !== undefined ? { hostIo: options.hostIo } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
        ...(options.harnessRoot !== undefined ? { harnessRoot: options.harnessRoot } : {}),
        ...(options.pgidDir !== undefined ? { pgidDir: options.pgidDir } : {}),
        ...(options.statUidSync !== undefined ? { statUidSync: options.statUidSync } : {}),
        ...(options.runProcess !== undefined ? { runProcess: options.runProcess } : {}),
      }

/** Executes an automatic unit via `claude -p` (`SPEC-0036 REQ-1.1`, `SPEC-0036 REQ-2.1`). */
export const runClaudeCodeImpl = Effect.fn("ClaudeCodeRunner.run")(function* (
  request: ClaudeCodeRunRequest,
  options?: ClaudeCodeRunnerOptions,
): Effect.fn.Return<AgentRunResult, AgentRunnerError> {
  const io = options?.hostIo ?? nodeSyncHostIo
  const parentEnv = options?.env ?? io.getEnv()
  const profile = CLAUDE_CODE_RUNNER_PROFILE
  const timeoutMs = options?.timeoutMs ?? profile.timeoutMillis
  const killGraceMs = options?.killGraceMs ?? WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs
  const harnessRoot = options?.harnessRoot ?? resolveHarnessInstallationRoot()
  const pgidRecordPath = yield* makeRunnerPgidRecordPath(
    request,
    io,
    options?.pgidDir,
    options?.statUidSync,
  )

  yield* reapOrphanAttemptProcessGroup(pgidRecordPath, io, "claude-code")

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
              exit: AgentNonZeroExitCode.make(1),
              kind: "exit",
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
        mcpConfigPath: RunnerConfigFilePath.make(mcpConfigPath),
        hooksSettingsPath: RunnerConfigFilePath.make(hooksSettingsPath),
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
        pgidRecordPath,
      })

      return yield* mapExecResult("claude-code", timeoutMs, execRes, parseClaudeCodeOutput)
    }),
  )
})

/** Executes an automatic unit via `agy -p` (`SPEC-0036 REQ-1.1`, `SPEC-0036 REQ-3.1`). */
export const runAntigravityImpl = Effect.fn("AntigravityRunner.run")(function* (
  request: AntigravityRunRequest,
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
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `Antigravity runner falling back to 'claude-code' for hard MCP isolation (unit=${request.brief.unitId})`,
          )
          yield* Effect.annotateCurrentSpan({
            fallbackFrom: "antigravity",
            runner: "claude-code",
          })
          return yield* runClaudeCodeImpl(
            {
              runId: request.runId,
              runner: "claude-code",
              brief: request.brief,
              cwd: request.cwd,
            },
            toClaudeFallbackOptions(options),
          )
        }),
      )
      .exhaustive()
  }

  const io = options?.hostIo ?? nodeSyncHostIo
  const parentEnv = options?.env ?? io.getEnv()
  const baseProfile = ANTIGRAVITY_RUNNER_PROFILE
  const timeoutMs = options?.timeoutMs ?? baseProfile.timeoutMillis
  const effectiveProfile =
    timeoutMs !== baseProfile.timeoutMillis
      ? AntigravityRunnerProfile.make({
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
  const pgidRecordPath = yield* makeRunnerPgidRecordPath(
    request,
    io,
    options?.pgidDir,
    options?.statUidSync,
  )

  yield* reapOrphanAttemptProcessGroup(pgidRecordPath, io, "antigravity")

  const argv = buildAntigravityArgv({
    profile: effectiveProfile,
    promptText: request.brief.promptText,
    killGraceMs,
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
        pgidRecordPath,
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

/** Dispatches `AgentRunRequest` to `ClaudeCodeRunnerLive` or `AntigravityRunnerLive` exhaustively (`SPEC-0036 REQ-1.1`). */
export const runAgentRunnerImpl = Effect.fn("AgentRunner.run")(function* (
  request: AgentRunRequest,
  options?: AgentRunnerPortOptions,
): Effect.fn.Return<AgentRunResult, AgentRunnerError> {
  return yield* match(request)
    .with({ runner: "claude-code" }, (claudeReq) =>
      runClaudeCodeImpl(claudeReq, mergeClaudeOptions(options)),
    )
    .with({ runner: "antigravity" }, (agyReq) =>
      runAntigravityImpl(agyReq, mergeAntigravityOptions(options)),
    )
    .exhaustive()
})

/** Builds a parameterized `AgentRunnerPort` layer with per-instance `profile.maxConcurrency` semaphores. */
const makeAgentRunnerPortLayer = (options?: AgentRunnerPortOptions): Layer.Layer<AgentRunnerPort> =>
  Layer.effect(
    AgentRunnerPort,
    Effect.gen(function* () {
      const claudeSemaphore = yield* Semaphore.make(CLAUDE_CODE_RUNNER_PROFILE.maxConcurrency)
      const antigravitySemaphore = yield* Semaphore.make(ANTIGRAVITY_RUNNER_PROFILE.maxConcurrency)
      return {
        run: (request) =>
          match(request)
            .with({ runner: "claude-code" }, (claudeReq) =>
              claudeSemaphore.withPermits(1)(
                runClaudeCodeImpl(claudeReq, mergeClaudeOptions(options)),
              ),
            )
            .with({ runner: "antigravity" }, (agyReq) =>
              antigravitySemaphore.withPermits(1)(
                runAntigravityImpl(agyReq, mergeAntigravityOptions(options)),
              ),
            )
            .exhaustive(),
      } satisfies AgentRunnerPortShape
    }),
  )

/** Builds a Claude-only `AgentRunnerPort` layer with per-instance `CLAUDE_CODE_RUNNER_PROFILE.maxConcurrency` semaphore. */
const makeClaudeCodeRunnerLayer = (
  options?: ClaudeCodeRunnerOptions,
): Layer.Layer<AgentRunnerPort> =>
  Layer.effect(
    AgentRunnerPort,
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(CLAUDE_CODE_RUNNER_PROFILE.maxConcurrency)
      return {
        run: (request) =>
          match(request)
            .with({ runner: "claude-code" }, (claudeReq) =>
              semaphore.withPermits(1)(runClaudeCodeImpl(claudeReq, options)),
            )
            .with({ runner: "antigravity" }, () =>
              Effect.fail(
                new AgentExitError({
                  runner: request.runner,
                  exit: AgentNonZeroExitCode.make(1),
                  kind: "exit",
                  detail: toAgentDiagnosticDetail(
                    "ClaudeCodeRunner cannot execute request for runner 'antigravity'",
                  ),
                }),
              ),
            )
            .exhaustive(),
      } satisfies AgentRunnerPortShape
    }),
  )

/** Builds an Antigravity-only `AgentRunnerPort` layer with per-instance `ANTIGRAVITY_RUNNER_PROFILE.maxConcurrency` semaphore. */
const makeAntigravityRunnerLayer = (
  options?: AntigravityRunnerOptions,
): Layer.Layer<AgentRunnerPort> =>
  Layer.effect(
    AgentRunnerPort,
    Effect.gen(function* () {
      const semaphore = yield* Semaphore.make(ANTIGRAVITY_RUNNER_PROFILE.maxConcurrency)
      return {
        run: (request) =>
          match(request)
            .with({ runner: "antigravity" }, (agyReq) =>
              semaphore.withPermits(1)(runAntigravityImpl(agyReq, options)),
            )
            .with({ runner: "claude-code" }, () =>
              Effect.fail(
                new AgentExitError({
                  runner: request.runner,
                  exit: AgentNonZeroExitCode.make(1),
                  kind: "exit",
                  detail: toAgentDiagnosticDetail(
                    "AntigravityRunner cannot execute request for runner 'claude-code'",
                  ),
                }),
              ),
            )
            .exhaustive(),
      } satisfies AgentRunnerPortShape
    }),
  )

/** Live `AgentRunnerPort` layer dispatching over `claude-code` and `antigravity`. */
export const AgentRunnerPortLive: Layer.Layer<AgentRunnerPort> = makeAgentRunnerPortLayer()

/** Dedicated Claude Code runner layer (`SPEC-0036 REQ-2.1`). */
export const ClaudeCodeRunnerLive: Layer.Layer<AgentRunnerPort> = makeClaudeCodeRunnerLayer()

/** Dedicated Antigravity runner layer (`SPEC-0036 REQ-3.1`). */
export const AntigravityRunnerLive: Layer.Layer<AgentRunnerPort> = makeAntigravityRunnerLayer()

export {
  makeAgentRunnerPortLayer,
  makeAntigravityRunnerLayer,
  makeClaudeCodeRunnerLayer,
  makeRunnerPgidRecordPath,
}
