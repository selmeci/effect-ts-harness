import { dirname } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AgentExitError,
  AgentNonZeroExitCode,
  AgentOutputParseError,
  type AgentRunnerError,
  type RunnerId,
  WORKFLOW_TIMEOUT_BUDGETS,
  toAgentDiagnosticDetail,
} from "@harness/contract"
import type { ExtendedHostIo, SyncHostExecResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import {
  isProcessGroupAlive,
  reapProcessGroup,
  spawnSupervisedProcessGroup,
} from "./verify-child-process.js"

const MAX_PGID_RECORD_BYTES = 4096

const PgidRecordSchema = Schema.Struct({
  pgid: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(2))),
  procStartTime: Schema.optional(Schema.NonEmptyString),
})
type PgidRecord = typeof PgidRecordSchema.Type

const PgidRecordJsonSchema = Schema.fromJsonString(PgidRecordSchema)
const decodePgidRecordResult = Schema.decodeUnknownResult(PgidRecordJsonSchema)
const encodePgidRecord = Schema.encodeSync(PgidRecordJsonSchema)

/** Options for spawning a supervised unit-worker subprocess inside its own POSIX process group. */
export interface SupervisedAgentExecOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly timeoutMs: number
  readonly killGraceMs?: number | undefined
  readonly pgidRecordPath?: string | undefined
  readonly hostIo?: ExtendedHostIo | undefined
  readonly runner?: RunnerId | undefined
}

const makePgidExitError = (runner: RunnerId, detail: string): AgentExitError =>
  new AgentExitError({
    runner,
    exit: AgentNonZeroExitCode.make(1),
    kind: "exit",
    detail: toAgentDiagnosticDetail(detail),
  })

const readLinuxProcStartTime = (pid: number, hostIo: ExtendedHostIo): string | undefined => {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid < 1) {
    return undefined
  }
  const statPath = `/proc/${pid}/stat`
  return Result.getOrElse(
    Result.try(() => {
      const raw = hostIo.readTextSync(statPath)
      const commEnd = raw.lastIndexOf(")")
      if (commEnd < 0) {
        return undefined
      }
      const tailFields = raw
        .slice(commEnd + 1)
        .trim()
        .split(/\s+/)
      // Field 22 (starttime) is index 19 after "(comm)" (fields 3..22).
      const startTicks = tailFields[19]
      return startTicks !== undefined && /^\d+$/.test(startTicks) ? startTicks : undefined
    }),
    () => undefined,
  )
}

const writeWarning = (message: string): void => {
  process.stderr.write(`[harness/infra] ${message}\n`)
}

const unlinkPgidRecordBestEffort = (pgidRecordPath: string, hostIo: ExtendedHostIo): void => {
  const res = Result.try({
    try: () => {
      if (hostIo.isSymbolicLinkSync(pgidRecordPath)) {
        writeWarning(`Refusing to unlink symlink pgid record '${pgidRecordPath}'`)
        return
      }
      if (hostIo.existsSync(pgidRecordPath)) {
        hostIo.unlinkSync(pgidRecordPath)
      }
    },
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  match(res)
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      writeWarning(`Failed to unlink pgid record '${pgidRecordPath}': ${failure}`)
    })
    .exhaustive()
}

/**
 * Atomically writes a PGID record using `tryWriteExclusiveTextSync` + `renameSync`.
 * Fails closed by returning `AgentExitError` on any symlink parent/dir/file,
 * pre-existing temp file (`Exists`), or filesystem write/mkdir/rename error.
 */
const writePgidRecordAtomic = (
  pgidRecordPath: string,
  pid: number,
  hostIo: ExtendedHostIo,
  runner: RunnerId = "claude-code",
): AgentExitError | undefined => {
  const dir = dirname(pgidRecordPath)
  const parentDir = dirname(dir)
  const tmpPath = `${pgidRecordPath}.tmp.${process.pid}.${pid}`
  const res = Result.try({
    try: (): AgentExitError | undefined => {
      if (hostIo.isSymbolicLinkSync(parentDir)) {
        return makePgidExitError(runner, `Refusing symlink pgid parent directory '${parentDir}'`)
      }
      if (hostIo.isSymbolicLinkSync(dir)) {
        return makePgidExitError(runner, `Refusing symlink pgid directory '${dir}'`)
      }
      if (hostIo.isSymbolicLinkSync(pgidRecordPath)) {
        return makePgidExitError(runner, `Refusing symlink pgid record '${pgidRecordPath}'`)
      }
      hostIo.mkdirRecursiveSync(dir, 0o700)
      if (hostIo.isSymbolicLinkSync(dir)) {
        return makePgidExitError(runner, `Refusing symlink pgid directory '${dir}' after mkdir`)
      }
      if (hostIo.isSymbolicLinkSync(pgidRecordPath)) {
        return makePgidExitError(runner, `Refusing symlink pgid record '${pgidRecordPath}'`)
      }
      const procStartTime = readLinuxProcStartTime(pid, hostIo)
      const payload: PgidRecord = {
        pgid: pid,
        ...(procStartTime !== undefined ? { procStartTime } : {}),
      }
      const writeRes = hostIo.tryWriteExclusiveTextSync(tmpPath, encodePgidRecord(payload), 0o600)
      return match(writeRes)
        .with({ _tag: "Written" }, () => {
          hostIo.renameSync(tmpPath, pgidRecordPath)
          return undefined
        })
        .with({ _tag: "Exists" }, () =>
          makePgidExitError(runner, `Refusing pre-existing temp pgid record '${tmpPath}'`),
        )
        .with({ _tag: "Failed" }, ({ code, message }) =>
          makePgidExitError(
            runner,
            `Failed to write temp pgid record '${tmpPath}'${code !== undefined ? ` (${code})` : ""}: ${message}`,
          ),
        )
        .exhaustive()
    },
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  return match(res)
    .with({ _tag: "Success" }, ({ success }) => success)
    .with({ _tag: "Failure" }, ({ failure }) => {
      unlinkPgidRecordBestEffort(tmpPath, hostIo)
      return makePgidExitError(
        runner,
        `Failed to write pgid record '${pgidRecordPath}': ${failure}`,
      )
    })
    .exhaustive()
}

const reapProcessGroupEffect = (pgid: number, termGraceMs: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const cancel = reapProcessGroup({
      pgid,
      termGraceMs,
      sigtermSent: false,
      sigkillSent: false,
      onSigtermSent: () => {},
      onSigkillSent: () => {},
      onSettled: () => {
        resume(Effect.void)
      },
    })
    return Effect.sync(() => {
      cancel()
    })
  })

const isLinuxProcStatReadable = (hostIo: ExtendedHostIo): boolean => {
  if (process.platform !== "linux") {
    return false
  }
  return Result.getOrElse(
    Result.try(() => hostIo.readTextSync(`/proc/${process.pid}/stat`).length > 0),
    () => false,
  )
}

/** Reaps any surviving process group left behind by a crashed workflow attempt before re-delivery. */
const reapOrphanAttemptProcessGroup = Effect.fnUntraced(function* (
  pgidRecordPath: string,
  hostIo?: ExtendedHostIo,
  runner: RunnerId = "claude-code",
): Effect.fn.Return<void, AgentRunnerError> {
  const io = hostIo ?? nodeSyncHostIo
  if (io.isSymbolicLinkSync(dirname(pgidRecordPath)) || io.isSymbolicLinkSync(pgidRecordPath)) {
    return yield* makePgidExitError(
      runner,
      `Refusing symlink pgid record '${pgidRecordPath}' during orphan reap`,
    )
  }
  if (!io.existsSync(pgidRecordPath)) {
    return
  }
  if (!io.isFileSync(pgidRecordPath)) {
    return yield* makePgidExitError(
      runner,
      `Refusing non-file pgid record '${pgidRecordPath}' during orphan reap`,
    )
  }

  const readRes = Result.try({
    try: () =>
      Buffer.from(io.readBytesPrefixSync(pgidRecordPath, MAX_PGID_RECORD_BYTES)).toString("utf8"),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  const raw = yield* match(readRes)
    .with({ _tag: "Failure" }, ({ failure }) =>
      Effect.fail(
        makePgidExitError(
          runner,
          `Failed to read orphan pgid record '${pgidRecordPath}': ${failure}`,
        ),
      ),
    )
    .with({ _tag: "Success" }, ({ success }) => Effect.succeed(success))
    .exhaustive()

  const parsedRecord = match(decodePgidRecordResult(raw))
    .with({ _tag: "Failure" }, ({ failure }) => {
      writeWarning(`Corrupt orphan pgid record '${pgidRecordPath}': ${String(failure)}`)
      return undefined
    })
    .with({ _tag: "Success" }, ({ success }) => success)
    .exhaustive()

  if (parsedRecord === undefined || parsedRecord.pgid <= 1 || parsedRecord.pgid === process.pid) {
    unlinkPgidRecordBestEffort(pgidRecordPath, io)
    return
  }

  if (
    process.platform === "linux" &&
    parsedRecord.procStartTime === undefined &&
    isLinuxProcStatReadable(io)
  ) {
    writeWarning(
      `Refusing to reap orphan pgid ${parsedRecord.pgid}: missing procStartTime on Linux with /proc mounted`,
    )
    unlinkPgidRecordBestEffort(pgidRecordPath, io)
    return
  }

  const currentStartTime = readLinuxProcStartTime(parsedRecord.pgid, io)
  const pidReused =
    parsedRecord.procStartTime !== undefined &&
    currentStartTime !== undefined &&
    currentStartTime !== parsedRecord.procStartTime

  if (pidReused) {
    writeWarning(
      `Skipping orphan pgid ${parsedRecord.pgid} reap due to PID reuse (recorded=${parsedRecord.procStartTime}, current=${currentStartTime})`,
    )
    unlinkPgidRecordBestEffort(pgidRecordPath, io)
    return
  }

  if (isProcessGroupAlive(parsedRecord.pgid)) {
    yield* reapProcessGroupEffect(parsedRecord.pgid, WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs)
  }

  unlinkPgidRecordBestEffort(pgidRecordPath, io)
})

/** Spawns a runner binary with `stdio: ["ignore", "pipe", "pipe"]` and POSIX process-group reaping on every settle path. */
const spawnSupervisedAgentProcess = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: SupervisedAgentExecOptions,
): Effect.Effect<SyncHostExecResult, AgentRunnerError> => {
  const io = opts.hostIo ?? nodeSyncHostIo
  const killGraceMs = Math.max(0, opts.killGraceMs ?? WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs)
  const runner: RunnerId = opts.runner ?? "claude-code"
  const pgidRecordPath = opts.pgidRecordPath

  return spawnSupervisedProcessGroup<AgentRunnerError>(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    killGraceMs,
    stdoutCaptureMode: "head-1m",
    mapSpawnThrow: (failure) =>
      new AgentExitError({
        runner,
        exit: AgentNonZeroExitCode.make(1),
        kind: "spawn-failed",
        detail: toAgentDiagnosticDetail(
          `Failed to spawn '${cmd}': ${failure} — ensure executable is installed on PATH (run 'pnpm harness workflow doctor')`,
        ),
      }),
    mapStdoutOverflow: (maxBytes) =>
      new AgentOutputParseError({
        runner,
        detail: toAgentDiagnosticDetail(
          `Runner '${runner}' stdout exceeded ${maxBytes} bytes capture limit`,
        ),
      }),
    ...(pgidRecordPath !== undefined
      ? {
          pgidRecord: {
            onSpawned: (pid) => writePgidRecordAtomic(pgidRecordPath, pid, io, runner),
            onSettledCleanup: () => {
              unlinkPgidRecordBestEffort(pgidRecordPath, io)
            },
          },
        }
      : {}),
  })
}

export { reapOrphanAttemptProcessGroup, spawnSupervisedAgentProcess, writePgidRecordAtomic }
