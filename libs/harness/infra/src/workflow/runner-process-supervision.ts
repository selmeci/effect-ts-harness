import { spawn } from "node:child_process"
import { dirname } from "node:path"
import { Effect, Result, Schema } from "effect"
import { match } from "ts-pattern"
import {
  AgentExitCode,
  AgentExitError,
  AgentOutputParseError,
  type AgentRunnerError,
  type RunnerId,
  WORKFLOW_TIMEOUT_BUDGETS,
  toAgentDiagnosticDetail,
} from "@harness/contract"
import type { ExtendedHostIo, SyncHostExecResult } from "@harness/service/host-io"
import { nodeSyncHostIo } from "../node-host-io.js"
import {
  appendBoundedTailChunk,
  createBoundedTailBuffer,
  isProcessGroupAlive,
  killProcessGroupPosix,
  readBoundedTailText,
  reapProcessGroup,
  signalChildProcessGroup,
} from "./verify-child-process.js"

const STDIO_DRAIN_GRACE_MS = 100
const MAX_RUNNER_STDOUT_BYTES = 1024 * 1024
const MAX_PGID_RECORD_BYTES = 4096

interface BoundedHeadBuffer {
  readonly chunks: Array<Buffer>
  totalBytes: number
  overflowed: boolean
}

const createBoundedHeadBuffer = (): BoundedHeadBuffer => ({
  chunks: [],
  totalBytes: 0,
  overflowed: false,
})

const appendBoundedHeadChunk = (state: BoundedHeadBuffer, chunk: Buffer | string): void => {
  if (state.overflowed) {
    return
  }
  const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
  if (buf.length === 0) {
    return
  }
  const remaining = MAX_RUNNER_STDOUT_BYTES - state.totalBytes
  if (buf.length > remaining) {
    if (remaining > 0) {
      state.chunks.push(buf.subarray(0, remaining))
      state.totalBytes += remaining
    }
    state.overflowed = true
    return
  }
  state.chunks.push(buf)
  state.totalBytes += buf.length
}

const readBoundedHeadText = (state: BoundedHeadBuffer): string =>
  state.totalBytes === 0 ? "" : Buffer.concat(state.chunks, state.totalBytes).toString("utf8")

const PgidRecordSchema = Schema.Struct({
  pgid: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
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

const writePgidRecordAtomic = (
  pgidRecordPath: string,
  pid: number,
  hostIo: ExtendedHostIo,
): void => {
  const dir = dirname(pgidRecordPath)
  const parentDir = dirname(dir)
  const tmpPath = `${pgidRecordPath}.tmp.${process.pid}.${pid}`
  const res = Result.try({
    try: () => {
      if (hostIo.isSymbolicLinkSync(parentDir)) {
        writeWarning(`Refusing symlink pgid parent directory '${parentDir}'`)
        return
      }
      if (hostIo.isSymbolicLinkSync(dir)) {
        writeWarning(`Refusing symlink pgid directory '${dir}'`)
        return
      }
      if (hostIo.isSymbolicLinkSync(pgidRecordPath)) {
        writeWarning(`Refusing symlink pgid record '${pgidRecordPath}'`)
        return
      }
      hostIo.mkdirRecursiveSync(dir, 0o700)
      if (hostIo.isSymbolicLinkSync(dir)) {
        writeWarning(`Refusing symlink pgid directory '${dir}' after mkdir`)
        return
      }
      const procStartTime = readLinuxProcStartTime(pid, hostIo)
      const payload: PgidRecord = {
        pgid: pid,
        ...(procStartTime !== undefined ? { procStartTime } : {}),
      }
      const writeRes = hostIo.tryWriteExclusiveTextSync(tmpPath, encodePgidRecord(payload), 0o600)
      match(writeRes)
        .with({ _tag: "Written" }, () => {
          hostIo.renameSync(tmpPath, pgidRecordPath)
        })
        .with({ _tag: "Exists" }, () => {
          writeWarning(`Refusing pre-existing temp pgid record '${tmpPath}'`)
        })
        .with({ _tag: "Failed" }, ({ code, message }) => {
          writeWarning(
            `Failed to write temp pgid record '${tmpPath}'${code !== undefined ? ` (${code})` : ""}: ${message}`,
          )
        })
        .exhaustive()
    },
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  match(res)
    .with({ _tag: "Success" }, () => undefined)
    .with({ _tag: "Failure" }, ({ failure }) => {
      writeWarning(`Failed to write pgid record '${pgidRecordPath}': ${failure}`)
      unlinkPgidRecordBestEffort(tmpPath, hostIo)
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
): Effect.fn.Return<void, AgentRunnerError> {
  const io = hostIo ?? nodeSyncHostIo
  if (io.isSymbolicLinkSync(dirname(pgidRecordPath)) || io.isSymbolicLinkSync(pgidRecordPath)) {
    writeWarning(`Refusing symlink pgid record '${pgidRecordPath}' during orphan reap`)
    return
  }
  if (!io.existsSync(pgidRecordPath)) {
    return
  }
  if (!io.isFileSync(pgidRecordPath)) {
    writeWarning(`Ignoring non-file pgid record '${pgidRecordPath}' during orphan reap`)
    return
  }

  const readRes = Result.try({
    try: () =>
      Buffer.from(io.readBytesPrefixSync(pgidRecordPath, MAX_PGID_RECORD_BYTES)).toString("utf8"),
    catch: (err) => (err instanceof Error ? err.message : String(err)),
  })
  const parsedRecord = match(readRes)
    .with({ _tag: "Failure" }, ({ failure }) => {
      writeWarning(`Failed to read orphan pgid record '${pgidRecordPath}': ${failure}`)
      return undefined
    })
    .with({ _tag: "Success" }, ({ success: raw }) =>
      match(decodePgidRecordResult(raw))
        .with({ _tag: "Failure" }, ({ failure }) => {
          writeWarning(`Corrupt orphan pgid record '${pgidRecordPath}': ${String(failure)}`)
          return undefined
        })
        .with({ _tag: "Success" }, ({ success }) => success)
        .exhaustive(),
    )
    .exhaustive()

  if (parsedRecord === undefined) {
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

/** Spawns a runner binary with `stdio: ["ignore", "pipe", "pipe"]` and POSIX process-group timeout/interrupt reaping. */
const spawnSupervisedAgentProcess = (
  cmd: string,
  args: ReadonlyArray<string>,
  opts: SupervisedAgentExecOptions,
): Effect.Effect<SyncHostExecResult, AgentRunnerError> => {
  const io = opts.hostIo ?? nodeSyncHostIo
  const killGraceMs = Math.max(0, opts.killGraceMs ?? WORKFLOW_TIMEOUT_BUDGETS.agentKillGraceMs)
  const runner: RunnerId = opts.runner ?? "claude-code"

  return Effect.callback<SyncHostExecResult, AgentRunnerError>((resume) => {
    let settled = false
    let timedOut = false
    let childExited = false
    let childClosed = false
    let sigtermSent = false
    let sigtermSentAtMs: number | undefined = undefined
    let sigkillSent = false
    let reapComplete = false
    let reapCancel: (() => void) | undefined = undefined
    let exitOutcome:
      | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
      | undefined = undefined
    const stdoutBuf = createBoundedHeadBuffer()
    const stderrBuf = createBoundedTailBuffer()
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined = undefined
    let stdioDrainTimer: ReturnType<typeof setTimeout> | undefined = undefined
    const exitWaiters: Array<() => void> = []

    const spawnRes = Result.try({
      try: () =>
        spawn(cmd, args, {
          cwd: opts.cwd,
          env: { ...opts.env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        }),
      catch: (err) => (err instanceof Error ? err.message : String(err)),
    })

    const child = match(spawnRes)
      .with({ _tag: "Success" }, ({ success }) => success)
      .with({ _tag: "Failure" }, ({ failure }) => {
        resume(
          Effect.fail(
            new AgentExitError({
              runner,
              exit: AgentExitCode.make(1),
              detail: toAgentDiagnosticDetail(`Failed to spawn '${cmd}': ${failure}`),
            }),
          ),
        )
        return undefined
      })
      .exhaustive()

    if (child === undefined) {
      return undefined
    }

    if (opts.pgidRecordPath !== undefined && child.pid !== undefined) {
      writePgidRecordAtomic(opts.pgidRecordPath, child.pid, io)
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      appendBoundedHeadChunk(stdoutBuf, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      appendBoundedTailChunk(stderrBuf, chunk)
    })

    const sendGroupOrChildSignal = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined && killProcessGroupPosix(child.pid, signal)) {
        return
      }
      signalChildProcessGroup(child, signal)
    }

    const terminateChild = (): void => {
      if (sigtermSent || child.killed) {
        if (!sigkillSent) {
          const groupAlive = child.pid !== undefined && isProcessGroupAlive(child.pid)
          if (!childExited || groupAlive) {
            sigkillSent = true
            sendGroupOrChildSignal("SIGKILL")
          }
        }
        return
      }
      if (childExited || child.exitCode !== null || child.signalCode !== null) {
        return
      }
      sigtermSent = true
      sigtermSentAtMs = Date.now()
      sendGroupOrChildSignal("SIGTERM")
      killGraceTimer = setTimeout(() => {
        if (sigkillSent) {
          return
        }
        const groupAlive = child.pid !== undefined && isProcessGroupAlive(child.pid)
        if ((!childExited && child.exitCode === null && child.signalCode === null) || groupAlive) {
          sigkillSent = true
          sendGroupOrChildSignal("SIGKILL")
        }
      }, killGraceMs)
      killGraceTimer.unref()
    }

    const timeoutTimer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            terminateChild()
          }, opts.timeoutMs)
        : undefined
    if (timeoutTimer !== undefined) {
      timeoutTimer.unref()
    }

    const cleanupTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
      }
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer)
      }
      if (stdioDrainTimer !== undefined) {
        clearTimeout(stdioDrainTimer)
      }
    }

    const destroyStdio = (): void => {
      child.stdout?.removeAllListeners("data")
      child.stdout?.destroy()
      child.stderr?.removeAllListeners("data")
      child.stderr?.destroy()
    }

    const cleanupPgid = (): void => {
      if (opts.pgidRecordPath !== undefined) {
        unlinkPgidRecordBestEffort(opts.pgidRecordPath, io)
      }
    }

    const notifyChildExit = (): void => {
      childExited = true
      while (exitWaiters.length > 0) {
        const waiter = exitWaiters.shift()
        if (waiter !== undefined) {
          waiter()
        }
      }
    }

    const settleWithExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()
      destroyStdio()
      cleanupPgid()
      const stderr = readBoundedTailText(stderrBuf)
      if (timedOut) {
        resume(
          Effect.succeed({
            _tag: "TimedOut",
            stdout: readBoundedHeadText(stdoutBuf),
            stderr,
            ...(signal !== null ? { signal } : {}),
          }),
        )
        return
      }
      if (signal !== null) {
        resume(
          Effect.succeed({
            _tag: "Signaled",
            signal,
            stdout: readBoundedHeadText(stdoutBuf),
            stderr,
          }),
        )
        return
      }
      if (stdoutBuf.overflowed) {
        resume(
          Effect.fail(
            new AgentOutputParseError({
              runner,
              detail: toAgentDiagnosticDetail(
                `Runner '${runner}' stdout exceeded ${MAX_RUNNER_STDOUT_BYTES} bytes capture limit`,
              ),
            }),
          ),
        )
        return
      }
      const stdout = readBoundedHeadText(stdoutBuf)
      resume(
        Effect.succeed({
          _tag: "Exited",
          exitCode: code ?? 1,
          stdout,
          stderr,
        }),
      )
    }

    const scheduleStdioDrainOrSettle = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return
      }
      if (childClosed) {
        settleWithExit(code, signal)
        return
      }
      if (stdioDrainTimer === undefined) {
        stdioDrainTimer = setTimeout(() => {
          settleWithExit(code, signal)
        }, STDIO_DRAIN_GRACE_MS)
        stdioDrainTimer.unref()
      }
    }

    const handleTimedOutChildEvent = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        return
      }
      exitOutcome = { code, signal }
      const pgid = child.pid
      if (reapComplete || pgid === undefined || !isProcessGroupAlive(pgid)) {
        reapComplete = true
        scheduleStdioDrainOrSettle(code, signal)
        return
      }
      if (reapCancel !== undefined) {
        return
      }
      if (killGraceTimer !== undefined) {
        clearTimeout(killGraceTimer)
        killGraceTimer = undefined
      }
      const elapsedSinceTermMs =
        sigtermSentAtMs !== undefined ? Math.max(0, Date.now() - sigtermSentAtMs) : 0
      const remainingGraceMs = Math.max(0, killGraceMs - elapsedSinceTermMs)
      reapCancel = reapProcessGroup({
        pgid,
        termGraceMs: remainingGraceMs,
        sigtermSent,
        sigkillSent,
        onSigtermSent: () => {
          sigtermSent = true
          sigtermSentAtMs = Date.now()
        },
        onSigkillSent: () => {
          sigkillSent = true
        },
        onSettled: () => {
          reapCancel = undefined
          reapComplete = true
          if (settled) {
            return
          }
          const finalOutcome = exitOutcome ?? { code, signal }
          scheduleStdioDrainOrSettle(finalOutcome.code, finalOutcome.signal)
        },
      })
    }

    child.once("error", (err) => {
      notifyChildExit()
      if (settled) {
        return
      }
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()
      destroyStdio()
      cleanupPgid()
      resume(
        Effect.succeed({
          _tag: "SpawnFailed",
          spawnError: err.message,
          stdout: readBoundedHeadText(stdoutBuf),
          stderr: readBoundedTailText(stderrBuf),
        }),
      )
    })

    child.once("exit", (code, signal) => {
      notifyChildExit()
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
      }
      if (settled) {
        return
      }
      if (timedOut) {
        handleTimedOutChildEvent(code, signal)
        return
      }
      if (stdioDrainTimer === undefined) {
        stdioDrainTimer = setTimeout(() => {
          settleWithExit(code, signal)
        }, STDIO_DRAIN_GRACE_MS)
        stdioDrainTimer.unref()
      }
    })

    child.once("close", (code, signal) => {
      notifyChildExit()
      childClosed = true
      if (settled) {
        return
      }
      if (timedOut) {
        handleTimedOutChildEvent(code, signal)
        return
      }
      settleWithExit(code, signal)
    })

    return Effect.callback<void>((done) => {
      const sigtermAlreadySentBeforeInterrupt = sigtermSent
      settled = true
      reapCancel?.()
      reapCancel = undefined
      cleanupTimers()

      let finalized = false
      const finishInterrupt = (): void => {
        if (finalized) {
          return
        }
        finalized = true
        reapCancel = undefined
        cleanupPgid()
        done(Effect.void)
      }

      const awaitProcessGroupExit = (): void => {
        cleanupTimers()
        destroyStdio()
        const termGraceMs = sigtermAlreadySentBeforeInterrupt
          ? 0
          : sigtermSentAtMs !== undefined
            ? Math.max(0, sigtermSentAtMs + killGraceMs - Date.now())
            : killGraceMs
        reapCancel = reapProcessGroup({
          pgid: child.pid,
          termGraceMs,
          sigtermSent,
          sigkillSent,
          onSigtermSent: () => {
            sigtermSent = true
            sigtermSentAtMs = Date.now()
          },
          onSigkillSent: () => {
            sigkillSent = true
          },
          onSettled: finishInterrupt,
        })
      }

      if (childExited || child.exitCode !== null || child.signalCode !== null) {
        awaitProcessGroupExit()
        return
      }
      exitWaiters.push(awaitProcessGroupExit)
      terminateChild()
    })
  })
}

export { reapOrphanAttemptProcessGroup, spawnSupervisedAgentProcess }
