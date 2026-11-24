import { constants } from "node:os"
import { extname, join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  type AbsoluteRepoRoot,
  type CircuitBreakerStatus,
  GateDurationMs,
  GateExitCode,
  GateStderrSummary,
  MutationRestoreError,
  ShipFailureMessage,
  ShipGateFailedError,
  type ShipRecoverBackupInput,
  type ShipStage,
  type ShipStageCommandInput,
  ShipStageFailed,
  ShipStagePassed,
  ShipStreamProgressEvent,
  type ShipTreeHashInput,
  WORKFLOW_TIMEOUT_BUDGETS,
  WorkspaceTreeHash,
  compareCodeUnits,
  toErrorReasonMessage,
  toShipFailureMessage,
} from "@harness/contract"
import {
  appendFrictionEvent,
  computeWorkspaceTreeHashChecked,
  decideLoopThrashing,
  readFrictionEvents,
  recoverStartupBackup,
} from "@harness/gates"
import { ShipGateRunner, type ShipGateRunnerShape } from "@harness/service"
import type {
  ExtendedHostIo,
  SyncHostExecExited,
  SyncHostExecResult,
  SyncHostIo,
} from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import { spawnVerifyCommand } from "./verify-child-process.js"

/** Optional overrides injected into `makeShipGateRunnerLayer`. */
export interface ShipGateRunnerOptions {
  readonly repoRoot?: AbsoluteRepoRoot | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly nowMs?: (() => number) | undefined
  readonly gateTimeoutMs?: number | undefined
  readonly onProgress?: ((event: ShipStreamProgressEvent) => void) | undefined
  readonly runCommand?:
    | ((
        cmd: string,
        args: ReadonlyArray<string>,
        opts: {
          readonly cwd: string
          readonly env: Readonly<Record<string, string | undefined>>
          readonly timeoutMs: number
        },
      ) => Effect.Effect<SyncHostExecResult, Error>)
    | undefined
}

/** Resolved subprocess command and argument vector for one `ShipStage`. */
export interface ResolvedShipGateCommand {
  readonly cmd: string
  readonly args: ReadonlyArray<string>
}

const MAX_STDERR_SUMMARY_CHARS = 4096
const MAX_FAILURE_MESSAGE_CHARS = 2048
const GIT_READ_MAX_BUFFER_BYTES = 16 * 1024 * 1024

const FORMATTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
])

const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecordOption = Schema.decodeUnknownOption(JsonRecordSchema)

const makeEnvHostIo = (
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
): SyncHostIo => ({ ...hostIo, getEnv: () => env })

const withoutWorktreeEnv = (
  baseEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => {
  const nextEnv: Record<string, string | undefined> = { ...baseEnv }
  Reflect.deleteProperty(nextEnv, "HARNESS_WORKTREE_ID")
  Reflect.deleteProperty(nextEnv, "HARNESS_STATE_DIR")
  return nextEnv
}

const withoutWorktreeEnvPlusCi = (
  baseEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> => ({
  ...withoutWorktreeEnv(baseEnv),
  CI: "true",
})

const normalizeRelPath = (raw: string): string => {
  let normalized = raw.replaceAll("\\", "/")
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2)
  }
  return normalized
}

const isIgnoredShipFormatPath = (relPath: string): boolean => {
  const parts = relPath.split("/")
  return (
    parts[0] === "repos" ||
    parts[0] === "dist" ||
    parts.some(
      (seg) => seg === ".harness" || seg === "node_modules" || seg === ".nx" || seg === ".git",
    )
  )
}

const makeFormatCheckGitError = (exitCode: GateExitCode, detail: string): ShipGateFailedError =>
  new ShipGateFailedError({
    stage: "format-check",
    exitCode,
    stderrSummary: toGateStderrSummary(detail),
    circuitBreakerStatus: "clear",
  })

const execGitRaw = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyArray<string>,
): Result.Result<SyncHostExecExited, ShipGateFailedError> =>
  match(
    Result.try(() =>
      hostIo.execFileSync("git", args, {
        cwd: repoRoot,
        env,
        maxBufferBytes: GIT_READ_MAX_BUFFER_BYTES,
      }),
    ),
  )
    .with({ _tag: "Failure" }, ({ failure }) =>
      Result.fail(
        makeFormatCheckGitError(
          GateExitCode.make(1),
          toErrorReasonMessage(failure, `git ${args.join(" ")} threw unexpectedly`),
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success }) =>
      match(success)
        .with({ _tag: "Exited" }, (exited) => Result.succeed(exited))
        .with({ _tag: "TimedOut" }, ({ stdout, stderr }) =>
          Result.fail(
            makeFormatCheckGitError(
              GateExitCode.make(1),
              stderr.trim() || stdout.trim() || `git ${args.join(" ")} timed out`,
            ),
          ),
        )
        .with({ _tag: "Signaled" }, ({ signal, stdout, stderr }) =>
          Result.fail(
            makeFormatCheckGitError(
              resolveSignaledExitCode(signal),
              stderr.trim() || stdout.trim() || `git ${args.join(" ")} signaled ${signal}`,
            ),
          ),
        )
        .with({ _tag: "SpawnFailed" }, ({ spawnError, stderr }) =>
          Result.fail(
            makeFormatCheckGitError(
              GateExitCode.make(1),
              spawnError.trim() || stderr.trim() || `git ${args.join(" ")} failed to spawn`,
            ),
          ),
        )
        .exhaustive(),
    )
    .exhaustive()

const execGitCheckedStdout = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyArray<string>,
): Result.Result<string, ShipGateFailedError> =>
  Result.flatMap(execGitRaw(repoRoot, hostIo, env, args), (exited) =>
    exited.exitCode === 0
      ? Result.succeed(exited.stdout)
      : Result.fail(
          makeFormatCheckGitError(
            toGateExitCode(exited.exitCode),
            exited.stderr.trim() ||
              exited.stdout.trim() ||
              `git ${args.join(" ")} exited with code ${exited.exitCode}`,
          ),
        ),
  )

const probeGitRefExists = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  ref: string,
): Result.Result<boolean, ShipGateFailedError> =>
  Result.flatMap(
    execGitRaw(repoRoot, hostIo, env, ["rev-parse", "--verify", "--quiet", ref]),
    (exited) => {
      if (exited.exitCode === 0) return Result.succeed(true)
      if (exited.exitCode === 1) return Result.succeed(false)
      return Result.fail(
        makeFormatCheckGitError(
          toGateExitCode(exited.exitCode),
          exited.stderr.trim() ||
            exited.stdout.trim() ||
            `git rev-parse --verify --quiet ${ref} exited with code ${exited.exitCode}`,
        ),
      )
    },
  )

const tryMergeBaseRange = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
  headSha: string,
  branches: ReadonlyArray<string>,
  sawHeadMatch = false,
): Result.Result<string | undefined, ShipGateFailedError> => {
  const [branch, ...rest] = branches
  if (branch === undefined) {
    if (sawHeadMatch) {
      return Result.succeed(undefined)
    }
    return Result.map(probeGitRefExists(repoRoot, hostIo, env, "HEAD~1"), (hasParent) =>
      hasParent ? "HEAD~1..HEAD" : undefined,
    )
  }
  return Result.flatMap(probeGitRefExists(repoRoot, hostIo, env, branch), (exists) => {
    if (!exists) {
      return tryMergeBaseRange(repoRoot, hostIo, env, headSha, rest, sawHeadMatch)
    }
    return Result.flatMap(
      execGitRaw(repoRoot, hostIo, env, ["merge-base", "HEAD", branch]),
      (mb) => {
        const mbSha = mb.stdout.trim()
        if (mb.exitCode === 0 && mbSha.length > 0) {
          if (mbSha === headSha) {
            return tryMergeBaseRange(repoRoot, hostIo, env, headSha, rest, true)
          }
          return Result.succeed(`${mbSha}..HEAD`)
        }
        if (mb.exitCode === 0 || mb.exitCode === 1) {
          return tryMergeBaseRange(repoRoot, hostIo, env, headSha, rest, sawHeadMatch)
        }
        return Result.fail(
          makeFormatCheckGitError(
            toGateExitCode(mb.exitCode),
            mb.stderr.trim() ||
              mb.stdout.trim() ||
              `git merge-base HEAD ${branch} exited with code ${mb.exitCode}`,
          ),
        )
      },
    )
  })
}

const splitGitNullPaths = (stdout: string): ReadonlyArray<string> =>
  stdout
    .split("\0")
    .map(normalizeRelPath)
    .filter((line) => line.length > 0)

const resolveCanonicalPath = (filePath: string, hostIo: SyncHostIo): string | undefined =>
  match(Result.try(() => hostIo.realpathSync(filePath)))
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, () => undefined)
    .exhaustive()

const isSafeRegularWorkspaceFile = (
  repoRoot: string,
  canonicalRoot: string | undefined,
  relPath: string,
  hostIo: SyncHostIo,
): boolean => {
  if (canonicalRoot === undefined || relPath.startsWith("/")) {
    return false
  }
  const parts = relPath.split("/")
  if (parts.some((seg) => seg.length === 0 || seg === "." || seg === "..")) {
    return false
  }
  for (let i = 0; i < parts.length; i += 1) {
    if (hostIo.isSymbolicLinkSync(join(repoRoot, ...parts.slice(0, i + 1)))) {
      return false
    }
  }
  const absPath = join(repoRoot, relPath)
  if (!hostIo.isFileSync(absPath)) {
    return false
  }
  const canonicalFile = resolveCanonicalPath(absPath, hostIo)
  if (canonicalFile === undefined) {
    return false
  }
  const rootPrefix = canonicalRoot.endsWith("/") ? canonicalRoot : `${canonicalRoot}/`
  return canonicalFile.startsWith(rootPrefix)
}

/**
 * Resolves the sorted, deduplicated list of changed regular files eligible for `oxfmt --check`
 * during the `"format-check"` ship stage, failing closed on unexpected git errors.
 */
const resolveShipFormatCheckFiles = (
  repoRoot: string,
  hostIo: SyncHostIo,
  env: Readonly<Record<string, string | undefined>>,
): Result.Result<ReadonlyArray<string>, ShipGateFailedError> =>
  Result.flatMap(probeGitRefExists(repoRoot, hostIo, env, "HEAD"), (hasHead) => {
    const committedRangeRes: Result.Result<string | undefined, ShipGateFailedError> = hasHead
      ? Result.flatMap(
          execGitCheckedStdout(repoRoot, hostIo, env, ["rev-parse", "--verify", "HEAD"]),
          (rawHeadSha) =>
            tryMergeBaseRange(repoRoot, hostIo, env, rawHeadSha.trim(), ["main", "origin/main"]),
        )
      : Result.succeed(undefined)
    return Result.flatMap(committedRangeRes, (committedRange) => {
      const queries: Array<ReadonlyArray<string>> = [
        ["diff", "--no-renames", "--cached", "--name-only", "-z"],
        ["ls-files", "--others", "--exclude-standard", "-z"],
      ]
      if (hasHead) {
        queries.unshift(["diff", "--no-renames", "--name-only", "-z", "HEAD"])
      }
      if (committedRange !== undefined) {
        queries.unshift(["diff", "--no-renames", "--name-only", "-z", committedRange])
      }
      const gitBase = ["-c", "core.quotePath=false"] as const
      return Result.map(
        Result.all(
          queries.map((q) =>
            Result.map(
              execGitCheckedStdout(repoRoot, hostIo, env, [...gitBase, ...q]),
              splitGitNullPaths,
            ),
          ),
        ),
        (buckets) => {
          const canonicalRoot = resolveCanonicalPath(repoRoot, hostIo)
          const unique = new Set<string>()
          for (const bucket of buckets) {
            for (const rel of bucket) {
              if (
                !isIgnoredShipFormatPath(rel) &&
                FORMATTABLE_EXTENSIONS.has(extname(rel).toLowerCase()) &&
                isSafeRegularWorkspaceFile(repoRoot, canonicalRoot, rel, hostIo)
              ) {
                unique.add(rel)
              }
            }
          }
          return Array.from(unique).sort(compareCodeUnits)
        },
      )
    })
  })

/** Resolves the canonical CLI command for one `ShipStage`, or `undefined` when `format-check` has 0 files. */
const resolveShipGateCommand = (
  stage: ShipStage,
  formatFiles: ReadonlyArray<string>,
): ResolvedShipGateCommand | undefined =>
  match(stage)
    .with("format-check", () =>
      formatFiles.length > 0
        ? { cmd: "pnpm", args: ["exec", "oxfmt", "--check", "--", ...formatFiles] }
        : undefined,
    )
    .with("gc-strict", () => ({ cmd: "pnpm", args: ["harness", "gc", "--strict"] }))
    .with("ontology-check-strict", () => ({
      cmd: "pnpm",
      args: ["harness", "ontology", "check", "--strict"],
    }))
    .with("mutate-strict", () => ({ cmd: "pnpm", args: ["harness", "mutate", "--strict"] }))
    .with("verify", () => ({ cmd: "pnpm", args: ["harness", "verify"] }))
    .with("done", () => ({ cmd: "pnpm", args: ["harness", "done", "--cli"] }))
    .exhaustive()

/** Parses `harness done --cli` stdout JSON and extracts a trimmed block reason if `decision` is `"block"` or `"continue"`. */
const extractDoneStdoutBlockReason = (stdout: string): string | undefined => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  const directOpt = decodeJsonRecordOption(trimmed)
  const parsedOpt = match(directOpt)
    .with({ _tag: "Some" }, (some) => some)
    .with({ _tag: "None" }, () => {
      const lines = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      const lastLine = lines[lines.length - 1]
      return lastLine !== undefined ? decodeJsonRecordOption(lastLine) : directOpt
    })
    .exhaustive()

  return match(parsedOpt)
    .with({ _tag: "None" }, () => undefined)
    .with({ _tag: "Some" }, ({ value }) => {
      if (value.decision !== "block" && value.decision !== "continue") {
        return undefined
      }
      if (typeof value.reason === "string" && value.reason.trim().length > 0) {
        return value.reason.trim()
      }
      return `harness done reported decision '${value.decision}'`
    })
    .exhaustive()
}

const toGateStderrSummary = (raw: string): GateStderrSummary => {
  const trimmed = raw.trim()
  return GateStderrSummary.make(
    trimmed.length <= MAX_STDERR_SUMMARY_CHARS
      ? trimmed
      : trimmed.slice(-MAX_STDERR_SUMMARY_CHARS).trim(),
  )
}

const toShipFailureMessageText = (
  raw: string,
  fallback = "Ship gate execution failed",
): ShipFailureMessage => {
  const trimmed = raw.trim()
  const bounded = (
    trimmed.length <= MAX_FAILURE_MESSAGE_CHARS
      ? trimmed
      : trimmed.slice(-MAX_FAILURE_MESSAGE_CHARS)
  ).trim()
  return ShipFailureMessage.make(bounded.length > 0 ? bounded : fallback)
}

const toGateDurationMs = (rawMs: number): GateDurationMs =>
  GateDurationMs.make(Number.isFinite(rawMs) ? Math.max(0, Math.round(rawMs)) : 0)

const toGateExitCode = (rawCode: number): GateExitCode =>
  GateExitCode.make(Number.isInteger(rawCode) ? Math.min(255, Math.max(1, rawCode)) : 1)

const resolveSignaledExitCode = (signal: string): GateExitCode => {
  const signalNumber = Reflect.get(constants.signals, signal)
  return typeof signalNumber === "number" && Number.isInteger(signalNumber) && signalNumber >= 1
    ? GateExitCode.make(Math.min(255, 128 + signalNumber))
    : GateExitCode.make(1)
}

const extractRunCommandFailureDiagnostic = (
  failure: Error,
  cmd: ResolvedShipGateCommand,
): string => {
  if (failure.message.trim().length > 0) {
    return failure.message.trim()
  }
  const reasonProp: unknown = Reflect.get(failure, "reason")
  if (typeof reasonProp === "string" && reasonProp.trim().length > 0) {
    return reasonProp.trim()
  }
  return toErrorReasonMessage(failure, `Command '${cmd.cmd} ${cmd.args.join(" ")}' failed`)
}

const evaluateGateExecOutcome = (
  stage: ShipStage,
  cmd: ResolvedShipGateCommand,
  execRes: SyncHostExecResult,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly exitCode: GateExitCode; readonly diagnostic: string } =>
  match(execRes)
    .with({ _tag: "Exited" }, ({ exitCode, stdout, stderr }) => {
      if (exitCode !== 0) {
        return {
          ok: false as const,
          exitCode: toGateExitCode(exitCode),
          diagnostic:
            stderr.trim() ||
            stdout.trim() ||
            `Command '${cmd.cmd} ${cmd.args.join(" ")}' exited with code ${exitCode}`,
        }
      }
      if (stage === "done") {
        const blockReason = extractDoneStdoutBlockReason(stdout)
        if (blockReason !== undefined) {
          return { ok: false as const, exitCode: GateExitCode.make(1), diagnostic: blockReason }
        }
      }
      return { ok: true as const }
    })
    .with({ _tag: "TimedOut" }, ({ stdout, stderr }) => ({
      ok: false as const,
      exitCode: GateExitCode.make(1),
      diagnostic:
        stderr.trim() || stdout.trim() || `Command '${cmd.cmd} ${cmd.args.join(" ")}' timed out`,
    }))
    .with({ _tag: "Signaled" }, ({ signal, stdout, stderr }) => ({
      ok: false as const,
      exitCode: resolveSignaledExitCode(signal),
      diagnostic:
        stderr.trim() ||
        stdout.trim() ||
        `Command '${cmd.cmd} ${cmd.args.join(" ")}' terminated by signal ${signal}`,
    }))
    .with({ _tag: "SpawnFailed" }, ({ spawnError, stderr }) => ({
      ok: false as const,
      exitCode: GateExitCode.make(1),
      diagnostic:
        spawnError.trim() ||
        stderr.trim() ||
        `Command '${cmd.cmd} ${cmd.args.join(" ")}' failed to spawn`,
    }))
    .exhaustive()

/** Computes the canonical `WorkspaceTreeHash` for a `ShipWorkflow` stage pre/post check. */
export const computeTreeHashImpl = Effect.fn("ShipGateRunner.computeTreeHash")(function* (
  input: ShipTreeHashInput,
  options?: ShipGateRunnerOptions,
): Effect.fn.Return<WorkspaceTreeHash, ShipGateFailedError> {
  const effectiveRoot = input.repoRoot ?? options?.repoRoot ?? process.cwd()
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const baseEnv = options?.env ?? hostIo.getEnv()
  const envHostIo = makeEnvHostIo(hostIo, withoutWorktreeEnv(baseEnv))

  return yield* match(computeWorkspaceTreeHashChecked(effectiveRoot, envHostIo))
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        new ShipGateFailedError({
          stage: input.stage,
          exitCode: GateExitCode.make(1),
          stderrSummary: toGateStderrSummary(failure),
          circuitBreakerStatus: "clear",
        }),
      ),
    )
    .exhaustive()
})

/** Restores any dangling mutation backup before `mutate --strict`, failing closed with `MutationRestoreError`. */
export const recoverMutationBackupImpl = Effect.fn("ShipGateRunner.recoverMutationBackup")(
  function* (
    input: ShipRecoverBackupInput,
    options?: ShipGateRunnerOptions,
  ): Effect.fn.Return<void, MutationRestoreError> {
    const effectiveRoot = input.repoRoot ?? options?.repoRoot ?? process.cwd()
    const hostIo = options?.hostIo ?? nodeSyncHostIo
    const baseEnv = options?.env ?? hostIo.getEnv()
    const envHostIo = makeEnvHostIo(hostIo, withoutWorktreeEnv(baseEnv))
    const backupPath = join(effectiveRoot, ".harness", "mutation-backup.json")

    const diagnostic = recoverStartupBackup(effectiveRoot, backupPath, envHostIo)
    if (diagnostic !== undefined) {
      const zeroSentinel = WorkspaceTreeHash.make("0".repeat(64))
      const altSentinel = WorkspaceTreeHash.make("f".repeat(64))
      const fallbackHash = input.expectedTreeHash === zeroSentinel ? altSentinel : zeroSentinel
      const { actual, detail } = match(computeWorkspaceTreeHashChecked(effectiveRoot, envHostIo))
        .with({ _tag: "Success" }, ({ success }) => ({
          actual: success,
          detail: toShipFailureMessageText(diagnostic, "Mutation backup restore failed"),
        }))
        .with({ _tag: "Failure" }, ({ failure }) => ({
          actual: fallbackHash,
          detail: toShipFailureMessageText(
            `Post-recovery tree hash failed (${failure}); ${diagnostic}`,
            "Mutation backup restore failed",
          ),
        }))
        .exhaustive()
      return yield* new MutationRestoreError({
        expected: input.expectedTreeHash,
        actual,
        detail,
      })
    }
  },
)

/** Executes one canonical `ShipStage` CLI command, streaming progress and recording friction telemetry on failure. */
export const executeStageCommandImpl = Effect.fn("ShipGateRunner.executeStageCommand")(function* (
  input: ShipStageCommandInput,
  options?: ShipGateRunnerOptions,
): Effect.fn.Return<ShipStagePassed, ShipGateFailedError> {
  const effectiveRoot = input.repoRoot ?? options?.repoRoot ?? process.cwd()
  const hostIo = options?.hostIo ?? nodeSyncHostIo
  const baseEnv = options?.env ?? hostIo.getEnv()
  const cleanEnv = withoutWorktreeEnv(baseEnv)
  const envHostIo = makeEnvHostIo(hostIo, cleanEnv)
  const nowMs = options?.nowMs ?? (() => Date.now())
  const startedMs = nowMs()

  options?.onProgress?.(
    ShipStreamProgressEvent.cases.StageStarted.make({
      runId: input.runId,
      attempt: input.attempt,
      stage: input.stage,
    }),
  )

  const beforeFriction = readFrictionEvents(effectiveRoot, envHostIo)

  const failStage = (
    exitCode: GateExitCode,
    diagnostic: string,
    durationMs: GateDurationMs,
  ): Effect.Effect<never, ShipGateFailedError> =>
    Effect.gen(function* () {
      const stderrSummary = toGateStderrSummary(diagnostic)
      const afterFriction = readFrictionEvents(effectiveRoot, envHostIo)
      const alreadyRecordedVerify =
        input.stage === "verify" &&
        afterFriction.length > beforeFriction.length &&
        afterFriction[afterFriction.length - 1]?.kind === "verify_failure"
      const latestEvents = alreadyRecordedVerify
        ? afterFriction
        : (() => {
            appendFrictionEvent(
              effectiveRoot,
              {
                kind: "verify_failure",
                summary: `ship:${input.stage}`,
                detail: stderrSummary,
                timestamp: new Date(nowMs()).toISOString(),
              },
              envHostIo,
            )
            return readFrictionEvents(effectiveRoot, envHostIo)
          })()

      const thrashing = yield* decideLoopThrashing(latestEvents)
      const circuitBreakerStatus: CircuitBreakerStatus = thrashing.stuck ? "tripped" : "clear"
      const escalationMessage =
        thrashing.escalationMessage !== null
          ? toShipFailureMessageText(thrashing.escalationMessage)
          : undefined

      const shipError = new ShipGateFailedError({
        stage: input.stage,
        exitCode,
        stderrSummary,
        circuitBreakerStatus,
        ...(escalationMessage !== undefined ? { escalationMessage } : {}),
      })

      options?.onProgress?.(
        ShipStreamProgressEvent.cases.StageFinished.make({
          runId: input.runId,
          attempt: input.attempt,
          progress: ShipStageFailed.make({
            stage: input.stage,
            durationMs,
            errorTag: "ShipGateFailedError",
            detail: toShipFailureMessage(shipError),
          }),
        }),
      )

      return yield* shipError
    })

  const formatFiles = yield* match(
    input.stage === "format-check"
      ? resolveShipFormatCheckFiles(effectiveRoot, envHostIo, cleanEnv)
      : Result.succeed<ReadonlyArray<string>>([]),
  )
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .with({ _tag: "Failure" }, ({ failure }) =>
      failStage(failure.exitCode, failure.stderrSummary, toGateDurationMs(nowMs() - startedMs)),
    )
    .exhaustive()
  const resolvedCmd = resolveShipGateCommand(input.stage, formatFiles)

  if (resolvedCmd === undefined) {
    const passed = ShipStagePassed.make({
      stage: input.stage,
      durationMs: toGateDurationMs(nowMs() - startedMs),
    })
    options?.onProgress?.(
      ShipStreamProgressEvent.cases.StageFinished.make({
        runId: input.runId,
        attempt: input.attempt,
        progress: passed,
      }),
    )
    return passed
  }

  const runCommand =
    options?.runCommand ??
    ((
      cmd: string,
      args: ReadonlyArray<string>,
      opts: {
        readonly cwd: string
        readonly env: Readonly<Record<string, string | undefined>>
        readonly timeoutMs: number
      },
    ) => spawnVerifyCommand(cmd, args, opts))

  const execEffectResult = yield* Effect.result(
    runCommand(resolvedCmd.cmd, resolvedCmd.args, {
      cwd: effectiveRoot,
      env: withoutWorktreeEnvPlusCi(baseEnv),
      timeoutMs: options?.gateTimeoutMs ?? WORKFLOW_TIMEOUT_BUDGETS.shipGateCommandMs,
    }),
  )

  const outcome = match(execEffectResult)
    .with({ _tag: "Failure" }, ({ failure }) => ({
      ok: false as const,
      exitCode: GateExitCode.make(1),
      diagnostic: extractRunCommandFailureDiagnostic(failure, resolvedCmd),
    }))
    .with({ _tag: "Success" }, ({ success: execRes }) =>
      evaluateGateExecOutcome(input.stage, resolvedCmd, execRes),
    )
    .exhaustive()

  const durationMs = toGateDurationMs(nowMs() - startedMs)
  if (outcome.ok) {
    const passed = ShipStagePassed.make({ stage: input.stage, durationMs })
    options?.onProgress?.(
      ShipStreamProgressEvent.cases.StageFinished.make({
        runId: input.runId,
        attempt: input.attempt,
        progress: passed,
      }),
    )
    return passed
  }

  return yield* failStage(outcome.exitCode, outcome.diagnostic, durationMs)
})

/** Constructs a live `ShipGateRunner` layer for `ShipWorkflow`. */
const makeShipGateRunnerLayer = (options?: ShipGateRunnerOptions): Layer.Layer<ShipGateRunner> =>
  Layer.succeed(ShipGateRunner, {
    computeTreeHash: (input) => computeTreeHashImpl(input, options),
    recoverMutationBackup: (input) => recoverMutationBackupImpl(input, options),
    executeStageCommand: (input) => executeStageCommandImpl(input, options),
  } satisfies ShipGateRunnerShape)

export {
  extractDoneStdoutBlockReason,
  makeShipGateRunnerLayer,
  resolveShipFormatCheckFiles,
  resolveShipGateCommand,
}

/** Default live `ShipGateRunner` layer using Node host I/O. */
export const ShipGateRunnerLive: Layer.Layer<ShipGateRunner> = makeShipGateRunnerLayer()
